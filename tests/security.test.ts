import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decryptBackup,
  encryptBackup,
} from '../src/server/security';

describe('backup serialization', () => {
  it('canonicalizes object keys recursively, preserving array order', async () => {
    const one = { z: [1, { b: 2, a: 1 }], a: 'ёж' };
    const two = { a: 'ёж', z: [1, { a: 1, b: 2 }] };
    expect(canonicalJson(one)).toBe('{"a":"ёж","z":[1,{"a":1,"b":2}]}');
    expect(await canonicalJson(one)).toBe(await canonicalJson(two));
    expect(await canonicalJson([1, 2])).not.toBe(await canonicalJson([2, 1]));
    for (const invalid of [
      NaN,
      Infinity,
      undefined,
      { a: undefined },
      new Date(),
      [, 1],
    ]) {
      expect(() => canonicalJson(invalid)).toThrow();
    }
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
  });
});

describe('portable encrypted backup', () => {
  it('restores independently of environment keys, supports larger data, and rejects tampering or wrong passphrases', async () => {
    const payload = {
      revision: 7,
      accounts: [{ login: 'admin', hash: 'sensitive' }],
      data: 'я'.repeat(40_000),
    };
    const archive = await encryptBackup(payload, 'backup passphrase 123');
    expect(archive.format).toBe('brownie-backup');
    expect(archive.kdf.iterations).toBe(600_000);
    expect(JSON.stringify(archive)).not.toContain('sensitive');
    expect(await decryptBackup(archive, 'backup passphrase 123')).toEqual(
      payload,
    );
    await expect(
      decryptBackup(archive, 'wrong passphrase 123'),
    ).rejects.toThrow();
    const changed = Uint8Array.from(
      atob(archive.encrypted.ciphertext),
      (character) => character.charCodeAt(0),
    );
    changed[0] = changed[0]! ^ 1;
    const encoded = Array.from(changed, (byte) =>
      String.fromCharCode(byte),
    ).join('');
    await expect(
      decryptBackup(
        {
          ...archive,
          encrypted: { ...archive.encrypted, ciphertext: btoa(encoded) },
        },
        'backup passphrase 123',
      ),
    ).rejects.toThrow();
    await expect(
      decryptBackup(
        { ...archive, kdf: { ...archive.kdf, iterations: 1 } },
        'backup passphrase 123',
      ),
    ).rejects.toThrow();
    await expect(
      decryptBackup(
        { ...archive, kdf: { ...archive.kdf, iterations: 2 ** 31 } },
        'backup passphrase 123',
      ),
    ).rejects.toThrow();
    await expect(encryptBackup(payload, 'short')).rejects.toThrow();
  }, 15_000);
});
