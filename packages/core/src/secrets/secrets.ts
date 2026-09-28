import type { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@tabreach/protocol';

/**
 * Encryption is done by the main process with Electron safeStorage (Keychain-backed).
 * Core only ever sees ciphertext at rest and asks main to decrypt on demand.
 */
export interface SecretCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertextBase64: string): Promise<string>;
}

export const secretPurposes = [
  'ai_api_key',
  'oauth_refresh_token',
  'oauth_client_secret',
  'imap_password',
  'self_test',
] as const;
export type SecretPurpose = (typeof secretPurposes)[number];

export class SecretNotFoundError extends Error {
  override name = 'SecretNotFoundError';
}

export class SecretStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Encrypts and stores a secret; returns its id (the `secret_id` other tables reference). */
  async put(purpose: SecretPurpose, plaintext: string): Promise<string> {
    const ciphertext = await this.cipher.encrypt(plaintext);
    const id = uuidv7();
    const ts = this.now().toISOString();
    this.db
      .prepare('INSERT INTO secrets (id, purpose, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, purpose, Buffer.from(ciphertext, 'base64'), ts, ts);
    return id;
  }

  async reveal(id: string): Promise<string> {
    const row = this.db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(id) as
      { ciphertext: Uint8Array } | undefined;
    if (!row) throw new SecretNotFoundError(`Secret ${id} not found`);
    return this.cipher.decrypt(Buffer.from(row.ciphertext).toString('base64'));
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
  }
}
