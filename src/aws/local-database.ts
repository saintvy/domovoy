import { PGlite } from '@electric-sql/pglite';
import type { Database, SqlClient } from './database';
import { schema } from './database';
import { initializeHousehold } from './application';

/** Test/development only: an actual embedded PostgreSQL engine, never bundled into Lambda. */
export async function createLocalDatabase(directory?: string) {
  const postgres = new PGlite(directory);
  await postgres.waitReady;
  await postgres.exec(schema);
  const database: Database = {
    transaction: (work) =>
      postgres.transaction(async (tx) =>
        work({
          query: async (sql, values) => {
            const result = await tx.query(sql, values);
            return { rows: result.rows, rowCount: result.affectedRows };
          },
        } as SqlClient),
      ),
  };
  await database.transaction(initializeHousehold);
  return { database, postgres };
}
