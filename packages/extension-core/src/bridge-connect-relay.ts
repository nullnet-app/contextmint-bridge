import { BRIDGE_CONNECT_APPROVAL, BRIDGE_CONNECT_MESSAGE_TYPE, DEFAULT_BRIDGE_ORIGIN, isAllowedGatewayOrigin } from './bridge-connect-contract.js';

function managedOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && isAllowedGatewayOrigin(item)))].slice(0, 3);
}

/** Relay only the exact approval posted by the configured gateway's own window. */
export function bridgeConnectRelayMessage(
  message: unknown,
  page: { origin: string; pathname: string; search: string; sourceIsSelf: boolean; allowedOrigins: string[] },
): { type: string; requestId: string; approval: string } | null {
  if (!page.sourceIsSelf || page.pathname !== '/bridge/connect') return null;
  let origin: URL;
  try { origin = new URL(page.origin); } catch { return null; }
  if (origin.origin !== page.origin || !isAllowedGatewayOrigin(page.origin) || !page.allowedOrigins.includes(page.origin)) return null;
  const params = new URLSearchParams(page.search);
  const requestId = params.get('request');
  const extra = [...params.keys()].some((key) => key !== 'request') || params.getAll('request').length !== 1;
  const msg = typeof message === 'object' && message !== null ? message as Record<string, unknown> : {};
  if (extra || typeof requestId !== 'string' || !/^bcr_[0-9a-f]{32}$/.test(requestId) || msg.type !== BRIDGE_CONNECT_MESSAGE_TYPE || msg.requestId !== requestId || typeof msg.approval !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(msg.approval)) return null;
  return { type: BRIDGE_CONNECT_APPROVAL, requestId, approval: msg.approval };
}

/** Content-script entry: this module has no vault, crypto, or background imports. */
export function installBridgeConnectRelay(): void {
  const c = (globalThis as { chrome?: { runtime?: { sendMessage?: (m: unknown) => Promise<unknown> }; storage?: { managed?: { get?: (keys: string[]) => Promise<Record<string, unknown>> } } } }).chrome;
  if (typeof c?.runtime?.sendMessage !== 'function') return;
  const configured = [DEFAULT_BRIDGE_ORIGIN];
  const managed = c.storage?.managed?.get?.(['bridgeConnectOrigins']);
  if (managed) void managed.then((values) => {
    configured.push(...managedOrigins(values.bridgeConnectOrigins).filter((item) => !configured.includes(item)));
  }).catch(() => {});
  window.addEventListener('message', (event: MessageEvent) => {
    const relay = bridgeConnectRelayMessage(event.data, {
      origin: location.origin,
      pathname: location.pathname,
      search: location.search,
      sourceIsSelf: event.source === window,
      allowedOrigins: configured,
    });
    if (relay) void c.runtime!.sendMessage!(relay).catch(() => {});
  });
}
