/** Portable backup encryption and strict serialization. Authentication is handled by Cognito. */
const encoder = new TextEncoder();
export const PASSWORD_ITERATIONS = 600_000;
const MAX_PASSWORD_ITERATIONS = 1_200_000;

export interface EncryptedSecret {
  version: 1;
  algorithm: 'AES-GCM';
  iv: string;
  ciphertext: string;
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 32_768)),
    );
  }
  return btoa(chunks.join(''));
}

function unbase64(value: string, maxBytes = 64_016): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 !== 0
  ) {
    throw new Error('Invalid base64');
  }
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
  if (bytes.length > maxBytes || base64(bytes) !== value)
    throw new Error('Non-canonical base64');
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Returns a field validation message, or null when valid. No password normalization is performed. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Enter a backup passphrase.';
  const length = Array.from(password).length;
  if (length < 12)
    return 'The backup passphrase must contain at least 12 characters.';
  if (length > 128)
    return 'The backup passphrase must contain no more than 128 characters.';
  return null;
}

async function derivePassword(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      256,
    ),
  );
}

async function aesKey(base64Key: string): Promise<CryptoKey> {
  const bytes = unbase64(base64Key);
  if (bytes.length !== 32)
    throw new Error(
      'Encryption key must contain 32 random bytes, encoded as base64',
    );
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptPayload(
  plaintext: string,
  base64Key: string,
  context: string,
  maxBytes: number,
): Promise<EncryptedSecret> {
  if (
    typeof plaintext !== 'string' ||
    encoder.encode(plaintext).length > maxBytes ||
    context.length > 1000
  )
    throw new Error('Secret exceeds size limit');
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(context),
      tagLength: 128,
    },
    await aesKey(base64Key),
    encoder.encode(plaintext),
  );
  return {
    version: 1,
    algorithm: 'AES-GCM',
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
}

async function decryptPayload(
  record: EncryptedSecret,
  base64Key: string,
  context: string,
  maxBytes: number,
): Promise<string> {
  if (
    !record ||
    record.version !== 1 ||
    record.algorithm !== 'AES-GCM' ||
    context.length > 1000
  )
    throw new Error('Unsupported secret format');
  const iv = unbase64(record.iv);
  const ciphertext = unbase64(record.ciphertext, maxBytes + 16);
  if (iv.length !== 12 || ciphertext.length < 16)
    throw new Error('Invalid encrypted secret');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(context),
      tagLength: 128,
    },
    await aesKey(base64Key),
    ciphertext,
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}

export interface EncryptedBackup {
  format: 'brownie-backup';
  version: 1;
  kdf: { algorithm: 'PBKDF2-SHA256'; salt: string; iterations: number };
  encrypted: EncryptedSecret;
}

/** Prototype size limit; server request/download limits must accommodate base64 expansion. */
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

/** Portable backup: independent random salt and IV; passphrase is never the server environment key. */
export async function encryptBackup(
  value: unknown,
  passphrase: string,
): Promise<EncryptedBackup> {
  const validation = validatePassword(passphrase);
  if (validation) throw new Error(validation);
  const plaintext = canonicalJson(value);
  if (encoder.encode(plaintext).length > MAX_BACKUP_BYTES)
    throw new Error('Backup exceeds size limit');
  const salt = randomBytes(16);
  const key = base64(
    await derivePassword(passphrase, salt, PASSWORD_ITERATIONS),
  );
  return {
    format: 'brownie-backup',
    version: 1,
    kdf: {
      algorithm: 'PBKDF2-SHA256',
      salt: base64(salt),
      iterations: PASSWORD_ITERATIONS,
    },
    encrypted: await encryptPayload(
      plaintext,
      key,
      'backup-v1',
      MAX_BACKUP_BYTES,
    ),
  };
}

/** Authenticity and KDF bounds are checked before parsing. Domain/schema validation remains caller-owned. */
export async function decryptBackup(
  archive: EncryptedBackup,
  passphrase: string,
): Promise<unknown> {
  if (
    validatePassword(passphrase) ||
    !archive ||
    archive.format !== 'brownie-backup' ||
    archive.version !== 1 ||
    !archive.kdf ||
    archive.kdf.algorithm !== 'PBKDF2-SHA256' ||
    !Number.isInteger(archive.kdf.iterations) ||
    archive.kdf.iterations < PASSWORD_ITERATIONS ||
    archive.kdf.iterations > MAX_PASSWORD_ITERATIONS
  ) {
    throw new Error('Invalid backup format or passphrase');
  }
  const salt = unbase64(archive.kdf.salt, 16);
  if (salt.length !== 16) throw new Error('Invalid backup salt');
  // Bound ciphertext before invoking the expensive password KDF.
  if (
    !archive.encrypted ||
    typeof archive.encrypted.ciphertext !== 'string' ||
    archive.encrypted.ciphertext.length >
      Math.ceil((MAX_BACKUP_BYTES + 16) / 3) * 4
  )
    throw new Error('Invalid backup payload');
  const key = base64(
    await derivePassword(passphrase, salt, archive.kdf.iterations),
  );
  return JSON.parse(
    await decryptPayload(archive.encrypted, key, 'backup-v1', MAX_BACKUP_BYTES),
  );
}

/** Version 1 canonical JSON: sorted object keys, native JSON finite numbers, no undefined or non-JSON objects. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function serialize(item: unknown, depth: number): string {
    if (depth > 100) throw new Error('JSON nesting exceeds limit');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean')
      return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Non-finite JSON number');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error('Unsupported JSON value');
    if (seen.has(item)) throw new Error('Cyclic JSON');
    seen.add(item);
    let serialized: string;
    if (Array.isArray(item)) {
      serialized = `[${Array.from(item, (entry) => serialize(entry, depth + 1)).join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('JSON object must be plain');
      if (Object.getOwnPropertySymbols(item).length)
        throw new Error('Symbol JSON keys are not supported');
      serialized = `{${Object.keys(item)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!('value' in descriptor))
            throw new Error('JSON accessors are not supported');
          return `${JSON.stringify(key)}:${serialize(descriptor.value, depth + 1)}`;
        })
        .join(',')}}`;
    }
    seen.delete(item);
    return serialized;
  }
  return serialize(value, 0);
}
