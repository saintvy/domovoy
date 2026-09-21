import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import type { State } from '../domain';
import { familySchema } from './family-schema';

export interface SqlClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface Database {
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}
export const entityKinds = [
  'people',
  'providers',
  'obligations',
  'rules',
  'periods',
  'accounts',
  'entitlements',
  'payments',
  'allocations',
  'refunds',
  'audit',
] as const;

/** This connection must never point at the existing application's database. */
export function assertDatabaseName(
  name: string | undefined,
): asserts name is string {
  if (!name || !/^brownie(?:_[a-z0-9_]+)?$/.test(name))
    throw new Error('PGDATABASE must be brownie or brownie_<environment>');
}

export const schema =
  `
CREATE TABLE IF NOT EXISTS brownie_household (
 id integer PRIMARY KEY CHECK (id = 1), household jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 0, instance_generation text NOT NULL,
 session_generation integer NOT NULL DEFAULT 1, auth_after bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS brownie_users (
 id text PRIMARY KEY, subject text UNIQUE, email text NOT NULL UNIQUE,
 name text NOT NULL, role text NOT NULL CHECK (role IN ('admin','editor','observer','participant')),
 person_id text, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS brownie_sessions (
 id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, user_id text NOT NULL REFERENCES brownie_users(id),
 generation integer NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL,
 revoked_at bigint, device_name text NOT NULL
);
CREATE INDEX IF NOT EXISTS brownie_sessions_user ON brownie_sessions(user_id);
CREATE TABLE IF NOT EXISTS brownie_entities (
 kind text NOT NULL CHECK (kind IN ('people','providers','obligations','rules','periods','accounts','entitlements','payments','allocations','refunds','audit')),
 id text NOT NULL, body jsonb NOT NULL, PRIMARY KEY (kind,id)
);
CREATE TABLE IF NOT EXISTS brownie_operations (
 id text PRIMARY KEY, actor_id text NOT NULL REFERENCES brownie_users(id), request_hash text NOT NULL,
 revision integer NOT NULL UNIQUE, committed_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS brownie_security_audit (
 id text PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, created_at bigint NOT NULL, details jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS brownie_restore_previews (
 token_hash text PRIMARY KEY, session_id text NOT NULL REFERENCES brownie_sessions(id) ON DELETE CASCADE,
 expires_at bigint NOT NULL, revision integer NOT NULL, generation text NOT NULL, state jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS brownie_backups (
 id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('automatic','manual','safety')),
 created_at bigint NOT NULL, revision integer NOT NULL
);
ALTER TABLE brownie_household ADD COLUMN IF NOT EXISTS deletion_at bigint;
ALTER TABLE brownie_household ADD COLUMN IF NOT EXISTS deletion_started_at bigint;
ALTER TABLE brownie_household ADD COLUMN IF NOT EXISTS deleted_at bigint;
ALTER TABLE brownie_household ADD COLUMN IF NOT EXISTS last_backup_at bigint;
ALTER TABLE brownie_household ADD COLUMN IF NOT EXISTS last_backup_revision integer;
ALTER TABLE brownie_household ADD COLUMN IF NOT EXISTS maintenance_error text;
` + familySchema;

export async function loadState(client: SqlClient, meta: any): Promise<State> {
  const state = {
    schemaVersion: 1,
    revision: meta.revision,
    household: meta.household,
  } as State;
  for (const kind of entityKinds) (state[kind] as unknown[]) = [];
  const result = await client.query(
    'SELECT kind,body FROM brownie_entities ORDER BY kind,id',
  );
  for (const row of result.rows)
    (state[row.kind as (typeof entityKinds)[number]] as unknown[]).push(
      row.body,
    );
  return state;
}

/** Persist changed entities only. PostgreSQL commits data, revision and receipt together. */
export async function saveState(
  client: SqlClient,
  before: State,
  after: State,
) {
  for (const kind of entityKinds) {
    const previous = new Map(
      before[kind].map((entity) => [entity.id, JSON.stringify(entity)]),
    );
    for (const entity of after[kind]) {
      const encoded = JSON.stringify(entity);
      if (previous.get(entity.id) !== encoded)
        await client.query(
          'INSERT INTO brownie_entities(kind,id,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET body=EXCLUDED.body',
          [kind, entity.id, encoded],
        );
      previous.delete(entity.id);
    }
    for (const id of previous.keys())
      await client.query(
        'DELETE FROM brownie_entities WHERE kind=$1 AND id=$2',
        [kind, id],
      );
  }
  await client.query(
    'UPDATE brownie_household SET household=$1::jsonb,revision=$2 WHERE id=1',
    [JSON.stringify(after.household), after.revision],
  );
}

export function createDatabase(env: NodeJS.ProcessEnv = process.env): Database {
  assertDatabaseName(env.PGDATABASE);
  if (!env.PGHOST || !env.PGUSER || !env.PGPASSWORD || !env.PGSSLROOTCERT)
    throw new Error('PostgreSQL connection and trusted RDS CA are required');
  const pool = new Pool({
    host: env.PGHOST,
    port: Number(env.PGPORT ?? 5432),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 15000,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(env.PGSSLROOTCERT, 'utf8'),
    },
    application_name: 'brownie-lambda',
    statement_timeout: 20000,
    idle_in_transaction_session_timeout: 25000,
  });
  pool.on('error', () => {
    /* A later request obtains a new connection; never log connection secrets. */
  });
  return {
    async transaction<T>(work: (client: SqlClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
