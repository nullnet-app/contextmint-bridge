/**
 * Match patterns for approved domains, shared by every script registered at
 * runtime on approved hosts only (the MAIN-world bridge, the page-load wake).
 */

const HOST_LABELS = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Chrome match patterns for a set of approved domains. `*://*.d/*` covers the
 * apex and every subdomain, as the trust check does. An IP address or a
 * dotless host gets an exact pattern (`*.` is only meaningful before a
 * domain). Anything that is not a plain hostname is dropped rather than
 * passed through — one invalid pattern makes Chrome reject the whole
 * registration, and a wildcard must never widen it.
 */
export function bridgeMatchPatterns(domains: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    if (typeof raw !== 'string') continue;
    const d = raw.toLowerCase();
    if (!HOST_LABELS.test(d)) continue;
    out.add(IPV4.test(d) || !d.includes('.') ? `*://${d}/*` : `*://*.${d}/*`);
  }
  return [...out].sort();
}
