import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  InvalidPasswordError,
  CURRENT_PARAMS,
} from '../../../server/services/auth/password';

describe('password.ts — first-party Argon2id password hashing', () => {
  it('hashes a valid password into an argon2id PHC string', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('never stores or returns the plaintext password', async () => {
    const password = 'correct horse battery staple';
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
  });

  it('verifies the correct password against its own hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects an incorrect password against a valid hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('rejects the empty string as a password on verify (never throws for wrong input)', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  it('never throws for a malformed/foreign hash — treats it as verification failure', async () => {
    await expect(verifyPassword('not-a-real-hash', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('$2b$10$fakeBcryptHashForTesting', 'anything')).resolves.toBe(false);
  });

  it('rejects passwords shorter than the minimum length', async () => {
    await expect(hashPassword('short1')).rejects.toBeInstanceOf(InvalidPasswordError);
  });

  it('rejects passwords longer than the maximum length', async () => {
    await expect(hashPassword('x'.repeat(600))).rejects.toBeInstanceOf(InvalidPasswordError);
  });

  it('accepts a password at exactly the minimum length', async () => {
    await expect(hashPassword('12345678')).resolves.toMatch(/^\$argon2id\$/);
  });

  it('needsRehash is false for a hash produced with current parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(needsRehash(hash)).toBe(false);
  });

  it('needsRehash is true for a non-argon2id (legacy) hash format', () => {
    expect(needsRehash('$2b$10$fakeBcryptHashForTesting')).toBe(true);
    expect(needsRehash('plaintext-or-garbage')).toBe(true);
  });

  it('needsRehash is true when stored params are weaker than current policy', () => {
    const weakerHash = `$argon2id$v=19$m=${CURRENT_PARAMS.memoryCost - 1},t=${CURRENT_PARAMS.timeCost},p=${CURRENT_PARAMS.parallelism}$c29tZXNhbHQ$ZmFrZWhhc2g`;
    expect(needsRehash(weakerHash)).toBe(true);
  });

  it('needsRehash is false when stored params meet or exceed current policy', () => {
    const strongerHash = `$argon2id$v=19$m=${CURRENT_PARAMS.memoryCost * 2},t=${CURRENT_PARAMS.timeCost},p=${CURRENT_PARAMS.parallelism}$c29tZXNhbHQ$ZmFrZWhhc2g`;
    expect(needsRehash(strongerHash)).toBe(false);
  });

  it('produces a different hash each time (random salt) even for the same password', async () => {
    const [a, b] = await Promise.all([
      hashPassword('correct horse battery staple'),
      hashPassword('correct horse battery staple'),
    ]);
    expect(a).not.toBe(b);
  });
});
