/**
 * Unit tests run vault code in ONE context, standing in for the background:
 * the vault's initialiser (`vault-migration.ts`). In a real build only the
 * background claims that role (`boot.ts`); every other context — the popup —
 * is a reader that asks the background and never mints. Tests of the reader
 * path switch roles explicitly (`tests/vault-single-owner.test.ts`).
 */
import { __setVaultRoleForTests } from '../../src/vault-migration.js';

__setVaultRoleForTests('owner');
