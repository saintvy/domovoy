import { randomUUID } from 'node:crypto';
import { createEmptyState, type State } from '../domain';
import type { SqlClient } from './database';
import type { Identity } from './identity';

export interface ApiRequest {
  path: string;
  method: string;
  identity?: Identity;
  token?: string;
  body?: Record<string, any>;
}
export interface BackupService {
  save(
    state: State,
    passphrase?: string,
  ): Promise<{ fileId: string; archive?: unknown; verified: boolean }>;
  purgeBatch?(): Promise<{ complete: boolean }>;
  remove?(key: string): Promise<void>;
}
/** Legacy singleton is initialized only for the idempotent migration source. Runtime uses FamilyApplication. */
export async function initializeHousehold(client: SqlClient) {
  const state = createEmptyState();
  await client.query(
    'INSERT INTO brownie_household(id,household,instance_generation) VALUES(1,$1::jsonb,$2) ON CONFLICT(id) DO NOTHING',
    [JSON.stringify(state.household), randomUUID()],
  );
}
