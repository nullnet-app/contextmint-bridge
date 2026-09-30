import { describe, expect, it } from 'vitest';
import { intersectDomains, isDomainSubset } from '../src/lib/scope.js';

describe('account domain scopes', () => {
  it('treats an approved domain as covering only itself and its subdomains', () => {
    expect(isDomainSubset(['shop.example.com'], ['example.com'])).toBe(true);
    expect(isDomainSubset(['example.com'], ['shop.example.com'])).toBe(false);
    expect(isDomainSubset(['notexample.com'], ['example.com'])).toBe(false);
    expect(intersectDomains(['example.com'], ['shop.example.com', 'other.net'])).toEqual(['shop.example.com']);
  });
});
