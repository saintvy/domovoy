/** Account membership is global; every financial operation is scoped to a locked family. */
export const familySchema = `
CREATE TABLE IF NOT EXISTS brownie_accounts (
 subject text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL
);
CREATE TABLE IF NOT EXISTS brownie_families (
 id text PRIMARY KEY, head_subject text NOT NULL REFERENCES brownie_accounts(subject),
 state jsonb NOT NULL, generation text NOT NULL, session_generation integer NOT NULL DEFAULT 1,
 auth_after bigint NOT NULL DEFAULT 0, created_at bigint NOT NULL,
 deleted_at bigint, last_backup_at bigint, last_backup_revision integer,
 maintenance_error text
);
CREATE TABLE IF NOT EXISTS brownie_memberships (
 subject text PRIMARY KEY REFERENCES brownie_accounts(subject),
 family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 person_id text NOT NULL, role text NOT NULL CHECK(role IN ('editor','own_editor','deleter','observer')),
 UNIQUE(family_id,person_id)
);
CREATE INDEX IF NOT EXISTS brownie_memberships_family ON brownie_memberships(family_id);
CREATE TABLE IF NOT EXISTS brownie_family_sessions (
 id text PRIMARY KEY, token_hash text NOT NULL UNIQUE,
 subject text NOT NULL REFERENCES brownie_accounts(subject),
 family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 generation integer NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL,
 revoked_at bigint, device_name text NOT NULL
);
CREATE INDEX IF NOT EXISTS brownie_family_sessions_subject ON brownie_family_sessions(subject);
CREATE TABLE IF NOT EXISTS brownie_family_operations (
 family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 id text NOT NULL, actor text NOT NULL, request_hash text NOT NULL, revision integer NOT NULL,
 committed_at bigint NOT NULL, PRIMARY KEY(family_id,id), UNIQUE(family_id,revision)
);
CREATE TABLE IF NOT EXISTS brownie_invitations (
 id text PRIMARY KEY, family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE, email text NOT NULL, person_id text NOT NULL,
 role text NOT NULL CHECK(role IN ('editor','own_editor','deleter','observer')),
 created_at bigint NOT NULL, expires_at bigint NOT NULL, accepted_at bigint, revoked_at bigint
);
CREATE INDEX IF NOT EXISTS brownie_invitations_family ON brownie_invitations(family_id);
CREATE TABLE IF NOT EXISTS brownie_family_backups (
 id text PRIMARY KEY, family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 created_at bigint NOT NULL, revision integer NOT NULL
);
CREATE TABLE IF NOT EXISTS brownie_family_audit (
 id text PRIMARY KEY, family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 actor text NOT NULL, action text NOT NULL, created_at bigint NOT NULL, details jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS brownie_manual_rates (
 family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 from_currency text NOT NULL, to_currency text NOT NULL, rate_date text NOT NULL,
 rate text NOT NULL, actor text NOT NULL, created_at bigint NOT NULL,
 PRIMARY KEY(family_id,from_currency,to_currency,rate_date)
);
ALTER TABLE brownie_families ADD COLUMN IF NOT EXISTS last_maintenance_at bigint;
-- Upgrade existing installations as well as fresh databases. Run by the schema owner.
ALTER TABLE brownie_memberships DROP CONSTRAINT IF EXISTS brownie_memberships_role_check;
ALTER TABLE brownie_memberships ADD CONSTRAINT brownie_memberships_role_check CHECK(role IN ('editor','own_editor','deleter','observer'));
ALTER TABLE brownie_invitations DROP CONSTRAINT IF EXISTS brownie_invitations_role_check;
ALTER TABLE brownie_invitations ADD CONSTRAINT brownie_invitations_role_check CHECK(role IN ('editor','own_editor','deleter','observer'));
`;
