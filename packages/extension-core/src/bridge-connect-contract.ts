/** Shared, dependency-free Connect names used by the page relay and background. */
export const BRIDGE_CONNECT_MESSAGE_TYPE = 'mcp-host/bridge-connect/v1';
export const BRIDGE_CONNECT_APPROVAL = 'mcp-host-bridge-connect-approval';
export const DEFAULT_BRIDGE_ORIGIN = 'https://mcp.nullnet.app';

export function isAllowedGatewayOrigin(origin: string): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  return url.origin === origin && url.protocol === 'https:' && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '';
}
