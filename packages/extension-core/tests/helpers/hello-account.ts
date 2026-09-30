import {
  ed25519Sign, generateEd25519, generateX25519, helloSignaturePayload,
  PROTOCOL_VERSION, toB64, type HelloFrameFromServer,
} from '@fetchproxy/protocol';

export async function buildHelloForAccountTest(): Promise<HelloFrameFromServer> {
  const x = await generateX25519();
  const ed = await generateEd25519();
  const session = await generateX25519();
  const nonce = new Uint8Array(32).fill(9);
  const mcpId = 'zillow:1.0.0:0123456789abcdef';
  return {
    type: 'hello', protocolVersion: PROTOCOL_VERSION, role: 'server', mcpId,
    serverName: 'zillow', version: '1.0.0', domains: ['zillow.com'], capabilities: ['fetch'],
    identityX25519Pub: toB64(x.publicKey), identityEd25519Pub: toB64(ed.publicKey),
    sessionNonce: toB64(nonce), sessionPub: toB64(session.publicKey),
    answersExtNonce: toB64(new Uint8Array(32).fill(0xcd)),
    sessionSig: toB64(await ed25519Sign(ed.privateKey,
      helloSignaturePayload(mcpId, nonce, session.publicKey, new Uint8Array(32).fill(0xcd)))),
  };
}
