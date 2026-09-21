import { randomUUID } from 'node:crypto';
import { createEmptyState, type State } from '../domain';
import type { SqlClient } from './database';

/** One-way, idempotent copy of the original single-family installation. Source tables are retained. */
export async function migrateFamilies(client: SqlClient) {
  await client.query(
    'CREATE TABLE IF NOT EXISTS brownie_migrations(version integer PRIMARY KEY, applied_at bigint NOT NULL)',
  );
  if (
    (
      await client.query(
        'SELECT version FROM brownie_migrations WHERE version=2',
      )
    ).rows.length
  )
    return;
  const old = (await client.query('SELECT * FROM brownie_household WHERE id=1'))
    .rows[0];
  const users = (
    await client.query(
      'SELECT * FROM brownie_users WHERE subject IS NOT NULL AND enabled ORDER BY id',
    )
  ).rows;
  if (old && !old.deleted_at && users.length) {
    const state: State = {
      ...createEmptyState(),
      household: old.household,
      revision: old.revision,
    };
    for (const row of (
      await client.query(
        'SELECT kind,body FROM brownie_entities ORDER BY kind,id',
      )
    ).rows) {
      const entities = state[row.kind as keyof State];
      if (Array.isArray(entities)) entities.push(row.body);
    }
    const familyId = randomUUID(),
      head = users.find((user) => user.role === 'admin') ?? users[0];
    state.household.id = familyId;
    for (const user of users)
      await client.query(
        'INSERT INTO brownie_accounts(subject,email,name) VALUES($1,$2,$3)',
        [user.subject, user.email, user.name],
      );
    // Each verified login gets a unique linked person; financial references remain untouched.
    const linked = new Set<string>();
    for (const user of users) {
      if (
        !user.person_id ||
        linked.has(user.person_id) ||
        !state.people.some((p) => p.id === user.person_id)
      ) {
        user.person_id = randomUUID();
        state.people.push({ id: user.person_id, displayName: user.name });
      }
      linked.add(user.person_id);
    }
    await client.query(
      'INSERT INTO brownie_families(id,head_subject,state,generation,created_at) VALUES($1,$2,$3::jsonb,$4,$5)',
      [familyId, head.subject, JSON.stringify(state), randomUUID(), Date.now()],
    );
    for (const user of users)
      await client.query(
        'INSERT INTO brownie_memberships(subject,family_id,person_id,role) VALUES($1,$2,$3,$4)',
        [
          user.subject,
          familyId,
          user.person_id,
          user.role === 'admin'
            ? 'deleter'
            : user.role === 'editor'
              ? 'editor'
              : 'observer',
        ],
      );
  }
  await client.query(
    'INSERT INTO brownie_migrations(version,applied_at) VALUES(2,$1)',
    [Date.now()],
  );
}
