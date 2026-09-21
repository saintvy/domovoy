import { Pool } from 'pg';
import type { Database, SqlClient } from '../src/aws/database';
import { familySchema } from '../src/aws/family-schema';
import { loadLocalEnvironment, validateLocalDatabaseUrl } from './local-config';
export async function openLocalPostgres() {
  const env = loadLocalEnvironment();
  const pool = new Pool({
    connectionString: validateLocalDatabaseUrl(env.BROWNIE_LOCAL_DATABASE_URL),
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 20000,
    idle_in_transaction_session_timeout: 25000,
    application_name: 'brownie-local',
  });
  pool.on('error', () => {});
  const database: Database = {
    async transaction<T>(work: (client: SqlClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='5s'");
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
  try {
    await database.transaction(async (c) => {
      await c.query(familySchema);
    });
  } catch {
    await pool.end();
    throw new Error(
      'Docker PostgreSQL is unavailable or migration failed. Run node scripts/dev-db.mjs up.',
    );
  }
  return { database, close: () => pool.end() };
}
