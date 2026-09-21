import { readFileSync } from 'node:fs';
import pg from 'pg';
import { schema, assertDatabaseName } from '../src/aws/database';
import { initializeHousehold } from '../src/aws/application';
import { migrateFamilies } from '../src/aws/migrate-families';

const identifier = (value: string) => pg.escapeIdentifier(value);
const literal = (value: string) => pg.escapeLiteral(value);

/** IAM invocation only. No HTTP trigger. No master credentials reach the application Lambda. */
export async function handler(event: unknown) {
  if (
    !event ||
    typeof event !== 'object' ||
    (event as { action?: string }).action !== 'provision'
  )
    throw new Error('Expected action=provision');
  const otherDatabase = (event as { verifyOtherDatabase?: unknown })
    .verifyOtherDatabase;
  if (
    otherDatabase !== undefined &&
    (typeof otherDatabase !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(otherDatabase))
  )
    throw new Error('Invalid database to verify');
  const database = process.env.PGDATABASE;
  assertDatabaseName(database);
  const runtime = process.env.BROWNIE_RUNTIME_USER ?? '';
  const password = process.env.BROWNIE_RUNTIME_PASSWORD ?? '';
  const owner = `${database}_owner`;
  if (
    database.length > 40 ||
    !/^brownie_[a-z0-9_]{1,54}$/.test(runtime) ||
    runtime === owner ||
    password.length < 20 ||
    password.includes('\0')
  )
    throw new Error('Invalid dedicated database login configuration');
  const options = {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(process.env.PGSSLROOTCERT!, 'utf8'),
    },
    connectionTimeoutMillis: 5000,
    statement_timeout: 20000,
    application_name: 'brownie-database-setup',
  };
  const admin = new pg.Client({ ...options, database: 'postgres' });
  let grantedOwner = false;
  let currentUser = '';
  const marker = `brownie-managed:${database}`;
  let stage = 'connect';
  try {
    await admin.connect();
    stage = 'roles';
    // Serialize retries of this tool without touching wcc tables.
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [
      `brownie-setup:${database}`,
    ]);
    currentUser = (await admin.query('SELECT current_user AS name')).rows[0]
      .name;
    for (const [role, login] of [
      [owner, false],
      [runtime, true],
    ] as const) {
      const existing = await admin.query(
        "SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,shobj_description(r.oid,'pg_authid') AS marker FROM pg_roles r WHERE rolname=$1",
        [role],
      );
      if (
        existing.rows.length &&
        (existing.rows[0].marker !== marker ||
          existing.rows[0].rolsuper ||
          existing.rows[0].rolcreatedb ||
          existing.rows[0].rolcreaterole)
      )
        throw new Error(
          'Refusing to modify an existing unmanaged PostgreSQL role',
        );
      if (!existing.rows.length) {
        // CREATE ROLE + marker are atomic, so a failed invocation remains safely retryable.
        await admin.query('BEGIN');
        try {
          await admin.query(
            `CREATE ROLE ${identifier(role)} ${login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
          );
          await admin.query(
            `COMMENT ON ROLE ${identifier(role)} IS ${literal(marker)}`,
          );
          await admin.query('COMMIT');
        } catch (error) {
          await admin.query('ROLLBACK');
          throw error;
        }
      }
    }
    const member = (
      await admin.query(
        "SELECT pg_has_role(current_user,$1,'MEMBER') AS member",
        [owner],
      )
    ).rows[0].member;
    if (!member) {
      await admin.query(
        `GRANT ${identifier(owner)} TO ${identifier(currentUser)}`,
      );
      grantedOwner = true;
    }
    const found = await admin.query(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
      [database],
    );
    stage = 'database';
    if (found.rows.length && found.rows[0].owner !== owner)
      throw new Error(
        'Refusing to touch a database owned by another application',
      );
    if (!found.rows.length)
      await admin.query(
        `CREATE DATABASE ${identifier(database)} OWNER ${identifier(owner)}`,
      );
    // PostgreSQL grants PUBLIC CONNECT by default. Restrict only the new Brownie database.
    await admin.query(
      `REVOKE ALL ON DATABASE ${identifier(database)} FROM PUBLIC`,
    );
    await admin.query(
      `GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(runtime)}`,
    );
    await admin.query(
      `ALTER ROLE ${identifier(runtime)} LOGIN CONNECTION LIMIT 6 PASSWORD ${literal(password)}`,
    );
    await admin.query(
      `ALTER ROLE ${identifier(runtime)} SET statement_timeout='20s'`,
    );
    await admin.query(
      `ALTER ROLE ${identifier(runtime)} SET idle_in_transaction_session_timeout='25s'`,
    );

    const migration = new pg.Client({ ...options, database });
    stage = 'migration';
    try {
      await migration.connect();
      await migration.query('BEGIN');
      await migration.query(`SET LOCAL ROLE ${identifier(owner)}`);
      await migration.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await migration.query(schema);
      await initializeHousehold(migration);
      await migrateFamilies(migration);
      await migration.query(
        `GRANT USAGE ON SCHEMA public TO ${identifier(runtime)}`,
      );
      await migration.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(runtime)}`,
      );
      await migration.query(
        `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier(runtime)}`,
      );
      await migration.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(owner)} IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${identifier(runtime)}`,
      );
      await migration.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(owner)} IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${identifier(runtime)}`,
      );
      await migration.query('COMMIT');
    } catch (error) {
      await migration.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await migration.end().catch(() => {});
    }
    // Test the actual application login and verify it cannot create tables.
    const verify = new pg.Client({
      ...options,
      database,
      user: runtime,
      password,
    });
    stage = 'runtime-verification';
    let tlsVersion: string | undefined;
    try {
      await verify.connect();
      const result = await verify.query(
        "SELECT (SELECT count(*) FROM brownie_household) AS households, has_schema_privilege(current_user,'public','CREATE') AS can_create",
      );
      if (Number(result.rows[0].households) !== 1 || result.rows[0].can_create)
        throw new Error('Runtime database permission verification failed');
      const tls = (
        await verify.query(
          'SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
        )
      ).rows[0];
      if (!tls?.ssl) throw new Error('TLS connection required');
      tlsVersion = tls.version;
    } finally {
      await verify.end().catch(() => {});
    }
    let isolation:
      | {
          database: string;
          readableRelations: number;
          writableRelations: number;
        }
      | undefined;
    if (typeof otherDatabase === 'string' && otherDatabase !== database) {
      stage = 'other-database-verification';
      const other = new pg.Client({ ...options, database: otherDatabase });
      try {
        await other.connect();
        // Read PostgreSQL permission metadata only; never read or change wcc application rows.
        const permissions = (
          await other.query(
            `SELECT
          count(*) FILTER (WHERE has_table_privilege($1,c.oid,'SELECT')) AS readable,
          count(*) FILTER (WHERE has_table_privilege($1,c.oid,'INSERT') OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_table_privilege($1,c.oid,'TRUNCATE')) AS writable
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`,
            [runtime],
          )
        ).rows[0];
        isolation = {
          database: otherDatabase,
          readableRelations: Number(permissions.readable),
          writableRelations: Number(permissions.writable),
        };
        if (isolation.readableRelations || isolation.writableRelations)
          throw new Error(
            'Runtime role has access to another application database',
          );
      } finally {
        await other.end().catch(() => {});
      }
    }
    return {
      ok: true,
      database,
      runtimeUser: runtime,
      tlsVersion,
      canCreateTables: false,
      isolation,
      nextStep:
        'Delete the BrownieDatabaseSetup CloudFormation stack to remove its administrator credentials.',
    };
  } catch (error) {
    // Do not propagate PostgreSQL error details: they can contain SQL and credentials.
    const candidate = (error as { code?: unknown })?.code;
    const code =
      typeof candidate === 'string' && /^[A-Z0-9_]{2,32}$/.test(candidate)
        ? candidate
        : 'UNKNOWN';
    console.error('Brownie database provisioning failed', { stage, code });
    throw new Error(
      `Database provisioning failed at ${stage} (${code}). Check private routing, administrator privileges, and managed role/database ownership. No wcc database tables are modified.`,
    );
  } finally {
    if (grantedOwner && currentUser)
      await admin
        .query(`REVOKE ${identifier(owner)} FROM ${identifier(currentUser)}`)
        .catch(() => {});
    await admin.end().catch(() => {});
  }
}
