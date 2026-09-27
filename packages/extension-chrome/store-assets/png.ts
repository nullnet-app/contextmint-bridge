/**
 * Just enough PNG to satisfy the Chrome Web Store: its screenshots and promo
 * tiles must be JPEG or 24-bit PNG with no alpha channel, and Chrome's
 * screenshots come out RGBA even when every pixel is opaque. Dev-only; never
 * bundled into the extension.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngInfo {
  width: number;
  height: number;
  /** 2 = RGB, 6 = RGBA. */
  colorType: number;
  bitDepth: number;
}

interface Chunk {
  type: string;
  data: Buffer;
}

function chunks(png: Buffer): Chunk[] {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const out: Chunk[] = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    out.push({ type, data: png.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return out;
}

export function pngInfo(png: Buffer): PngInfo {
  const ihdr = chunks(png)[0];
  if (!ihdr || ihdr.type !== 'IHDR') throw new Error('PNG has no IHDR');
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8]!,
    colorType: ihdr.data[9]!,
  };
}

let crcTable: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Undo the per-row filters of an 8-bit, non-interlaced image. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp]! : 0;
      const b = y > 0 ? out[dst - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp]! : 0;
      const v = raw[src + x]!;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      out[dst + x] = r & 0xff;
    }
  }
  return out;
}

/**
 * Re-encode an opaque 8-bit RGBA PNG as 24-bit RGB. A PNG that is already RGB
 * comes back unchanged; one with any pixel that is not fully opaque is
 * refused rather than silently flattened onto a colour nobody chose.
 */
export function stripAlpha(png: Buffer): Buffer {
  const info = pngInfo(png);
  if (info.colorType === 2) return png;
  if (info.colorType !== 6 || info.bitDepth !== 8) {
    throw new Error(`unsupported PNG: colour type ${info.colorType}, depth ${info.bitDepth}`);
  }
  const all = chunks(png);
  if (all[0]!.data[12] !== 0) throw new Error('interlaced PNGs are not supported');
  const idat = Buffer.concat(all.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const pixels = unfilter(inflateSync(idat), info.width, info.height, 4);

  const rowOut = info.width * 3 + 1;
  const rgb = Buffer.alloc(rowOut * info.height);
  for (let y = 0; y < info.height; y++) {
    rgb[y * rowOut] = 0;
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * 4;
      if (pixels[s + 3] !== 255) {
        throw new Error(`pixel (${x}, ${y}) is not opaque; the store wants no alpha`);
      }
      const d = y * rowOut + 1 + x * 3;
      rgb[d] = pixels[s]!;
      rgb[d + 1] = pixels[s + 1]!;
      rgb[d + 2] = pixels[s + 2]!;
    }
  }

  const ihdr = Buffer.from(all[0]!.data);
  ihdr[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    encodeChunk('IHDR', ihdr),
    encodeChunk('IDAT', deflateSync(rgb, { level: 9 })),
    encodeChunk('IEND', Buffer.alloc(0)),
  ]);
}
