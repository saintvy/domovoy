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
ALTER TABLE brownie_memberships ADD COLUMN IF NOT EXISTS telegram_report_time jsonb;
ALTER TABLE brownie_memberships ADD COLUMN IF NOT EXISTS next_telegram_report_at bigint;
CREATE INDEX IF NOT EXISTS brownie_memberships_telegram_due
 ON brownie_memberships(next_telegram_report_at) WHERE next_telegram_report_at IS NOT NULL;
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
CREATE TABLE IF NOT EXISTS brownie_telegram_links (
 subject text PRIMARY KEY REFERENCES brownie_memberships(subject) ON DELETE CASCADE,
 family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 telegram_user_id text NOT NULL UNIQUE, chat_id text NOT NULL UNIQUE,
 username text, linked_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS brownie_telegram_links_family ON brownie_telegram_links(family_id);
CREATE TABLE IF NOT EXISTS brownie_telegram_link_tokens (
 token_hash text PRIMARY KEY, subject text NOT NULL REFERENCES brownie_memberships(subject) ON DELETE CASCADE,
 family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 created_at bigint NOT NULL, expires_at bigint NOT NULL, consumed_at bigint
);
CREATE INDEX IF NOT EXISTS brownie_telegram_link_tokens_subject ON brownie_telegram_link_tokens(subject);
CREATE TABLE IF NOT EXISTS brownie_telegram_updates (
 update_id text PRIMARY KEY, handled_at bigint NOT NULL, ok boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS brownie_telegram_report_jobs (
 id text PRIMARY KEY, family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 subject text NOT NULL REFERENCES brownie_memberships(subject) ON DELETE CASCADE,
 family_generation text NOT NULL, telegram_linked_at bigint NOT NULL,
 report_date text NOT NULL, part integer NOT NULL DEFAULT 0, scheduled_for bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','attempted','retryable','accepted','failed','unknown','skipped')),
 attempt_id text, attempted_at bigint, finished_at bigint, retry_after bigint,
 message_id text, error_code text, item_keys jsonb, once_keys jsonb NOT NULL DEFAULT '[]'::jsonb, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS brownie_telegram_report_jobs_due
 ON brownie_telegram_report_jobs(retry_after) WHERE status='retryable';
CREATE TABLE IF NOT EXISTS brownie_telegram_once_receipts (
 family_id text NOT NULL REFERENCES brownie_families(id) ON DELETE CASCADE,
 subject text NOT NULL REFERENCES brownie_memberships(subject) ON DELETE CASCADE,
 obligation_id text NOT NULL, period_id text NOT NULL, job_id text NOT NULL,
 delivered_at bigint NOT NULL, outcome text NOT NULL CHECK(outcome IN ('reserved','accepted','unknown')),
 PRIMARY KEY(family_id,subject,obligation_id,period_id)
);
-- Upgrade pre-release installations that initialized the first reminder schema.
ALTER TABLE brownie_telegram_updates ADD COLUMN IF NOT EXISTS ok boolean NOT NULL DEFAULT false;
ALTER TABLE brownie_telegram_report_jobs ADD COLUMN IF NOT EXISTS part integer NOT NULL DEFAULT 0;
ALTER TABLE brownie_telegram_report_jobs ADD COLUMN IF NOT EXISTS item_keys jsonb;
ALTER TABLE brownie_telegram_report_jobs DROP CONSTRAINT IF EXISTS brownie_telegram_report_jobs_family_id_subject_report_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS brownie_telegram_report_jobs_report_part
 ON brownie_telegram_report_jobs(family_id,subject,report_date,part);
ALTER TABLE brownie_telegram_once_receipts DROP CONSTRAINT IF EXISTS brownie_telegram_once_receipts_outcome_check;
ALTER TABLE brownie_telegram_once_receipts ADD CONSTRAINT brownie_telegram_once_receipts_outcome_check CHECK(outcome IN ('reserved','accepted','unknown'));
ALTER TABLE brownie_families ADD COLUMN IF NOT EXISTS last_maintenance_at bigint;
-- Upgrade existing installations as well as fresh databases. Run by the schema owner.
ALTER TABLE brownie_memberships DROP CONSTRAINT IF EXISTS brownie_memberships_role_check;
ALTER TABLE brownie_memberships ADD CONSTRAINT brownie_memberships_role_check CHECK(role IN ('editor','own_editor','deleter','observer'));
ALTER TABLE brownie_invitations DROP CONSTRAINT IF EXISTS brownie_invitations_role_check;
ALTER TABLE brownie_invitations ADD CONSTRAINT brownie_invitations_role_check CHECK(role IN ('editor','own_editor','deleter','observer'));
`;
