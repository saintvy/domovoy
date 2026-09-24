import { randomInt, randomUUID } from 'node:crypto';
import {
  applyCommands,
  createEmptyState,
  decimalRate,
  effectiveReminderSettings,
  householdToday,
  isISODate,
  requiredExchangeRates,
  type Command,
  type ExchangeRate,
  type State,
} from '../domain';
import type { Database, SqlClient } from './database';
import {
  ApiError,
  canonical,
  check,
  digest,
  sessionToken,
  type Identity,
} from './identity';
import type { ApiRequest, BackupService } from './application';
import { authorizeFamilyCommands } from './family-permissions';
import {
  familyReportTime,
  nextTelegramReportAt,
  syncMemberTelegramSchedule,
  validateDailyReportTime,
  type TelegramReportPublisher,
} from './telegram-reminders';
import {
  isAppLocale,
  normalizeAppLocale,
  type AppLocale,
} from '../shared/locale';

export interface InvitationMessage {
  id: string;
  familyId: string;
  email: string;
  familyName: string;
  url: string;
  expiresAt: number;
  locale?: AppLocale;
}
export interface FamilyServices extends TelegramReportPublisher {
  clock?: () => number;
  appOrigin: string;
  sendInvitation?: (message: InvitationMessage) => Promise<void>;
  quotes?: (
    state: State,
    commands: Command[],
    overrides?: ExchangeRate[],
  ) => Promise<ExchangeRate[]>;
  backups?: (familyId: string) => BackupService;
  telegramBotUsername?: string;
}
const roles = ['editor', 'own_editor', 'deleter', 'observer'];
const editing = new Set(['admin', 'editor', 'own_editor', 'deleter']);
const normalize = (state: State): State => ({
  ...state,
  automaticPayments: state.automaticPayments ?? [],
  automaticPaymentRuns: state.automaticPaymentRuns ?? [],
});

/** The family id always comes from verified membership, never from a request body. */
export class FamilyApplication {
  private now: () => number;
  constructor(
    private db: Database,
    private services: FamilyServices,
  ) {
    this.now = services.clock ?? Date.now;
  }
  async handle(request: ApiRequest): Promise<any> {
    const path = request.path.replace(/^\/api(?=\/)/, ''),
      method = request.method,
      body = request.body ?? {};
    if (path === '/health' && method === 'GET')
      return { ok: true, architecture: 'aws-postgresql', localMode: false };
    check(request.identity, 'AUTH_REQUIRED', 401);
    const identity = request.identity;
    return this.db.transaction(async (client) => {
      // Lock the account before membership changes. Family commands lock only their family afterwards.
      await client.query(
        'INSERT INTO brownie_accounts(subject,email,name) VALUES($1,$2,$3) ON CONFLICT(subject) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name',
        [identity.subject, identity.email, identity.name],
      );
      let account = (
        await client.query(
          'SELECT * FROM brownie_accounts WHERE subject=$1 FOR UPDATE',
          [identity.subject],
        )
      ).rows[0];
      if (
        path === '/auth/session' &&
        method === 'POST' &&
        Object.prototype.hasOwnProperty.call(body, 'locale')
      ) {
        check(isAppLocale(body.locale), 'VALIDATION_FAILED');
        account = (
          await client.query(
            'UPDATE brownie_accounts SET preferred_locale=$1 WHERE subject=$2 RETURNING *',
            [body.locale, identity.subject],
          )
        ).rows[0];
      }
      if (path === '/account/preferences' && method === 'PATCH') {
        check(isAppLocale(body.locale), 'VALIDATION_FAILED');
        await client.query(
          'UPDATE brownie_accounts SET preferred_locale=$1 WHERE subject=$2',
          [body.locale, identity.subject],
        );
        return { ok: true };
      }
      if (path === '/families' && method === 'POST')
        return this.create(client, identity, body);
      if (path === '/invitations/accept' && method === 'POST')
        return this.accept(client, identity, body);
      let membership = (
        await client.query(
          'SELECT * FROM brownie_memberships WHERE subject=$1',
          [identity.subject],
        )
      ).rows[0];
      if (!membership) {
        if (
          (path === '/auth/session' && method === 'POST') ||
          (path === '/session' && method === 'GET')
        )
          return {
            initialized: true,
            onboarding: true,
            user: null,
            identity: {
              name: identity.name,
              email: identity.email,
              preferredLocale: account.preferred_locale ?? undefined,
            },
            authProvider: 'cognito-google',
          };
        throw new ApiError('FAMILY_REQUIRED', 409);
      }
      const family = (
        await client.query(
          'SELECT * FROM brownie_families WHERE id=$1 FOR UPDATE',
          [membership.family_id],
        )
      ).rows[0];
      check(family && !family.deleted_at, 'FAMILY_REQUIRED', 409);
      // Recheck after waiting for the family lock: another head may have removed the member.
      membership = (
        await client.query(
          'SELECT * FROM brownie_memberships WHERE subject=$1 AND family_id=$2',
          [identity.subject, family.id],
        )
      ).rows[0];
      check(membership, 'SESSION_REVOKED', 401);
      const user = this.user(
        identity,
        membership,
        family,
        account.preferred_locale,
      );
      if (path === '/auth/session' && method === 'POST')
        return this.login(client, identity, family, user, body);
      const session = await this.authenticate(
        client,
        identity,
        family,
        request.token,
      );
      const admin = () => check(user.role === 'admin', 'FORBIDDEN', 403);
      const editor = () => check(editing.has(user.role), 'FORBIDDEN', 403);
      if (path === '/session' && method === 'GET')
        return this.sessionInfo(family, user);
      if (path === '/auth/logout' && method === 'POST') {
        await client.query(
          'UPDATE brownie_family_sessions SET revoked_at=$1 WHERE id=$2',
          [this.now(), session.id],
        );
        return { ok: true };
      }
      if (path === '/telegram/link' && method === 'POST') {
        const token = sessionToken(),
          expiresAt = this.now() + 10 * 60000;
        await client.query(
          'UPDATE brownie_telegram_link_tokens SET consumed_at=$1 WHERE subject=$2 AND consumed_at IS NULL',
          [this.now(), identity.subject],
        );
        await client.query(
          'INSERT INTO brownie_telegram_link_tokens(token_hash,subject,family_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
          [digest(token), identity.subject, family.id, this.now(), expiresAt],
        );
        const username = (
          this.services.telegramBotUsername ?? 'domovoy_reminder_bot'
        ).replace(/^@/, '');
        await this.audit(
          client,
          family.id,
          identity.subject,
          'telegram.link-created',
          {},
        );
        return { url: `https://t.me/${username}?start=${token}`, expiresAt };
      }
      if (path === '/telegram/link' && method === 'DELETE') {
        await client.query(
          'DELETE FROM brownie_telegram_links WHERE subject=$1 AND family_id=$2',
          [identity.subject, family.id],
        );
        await client.query(
          'DELETE FROM brownie_telegram_link_tokens WHERE subject=$1 AND family_id=$2',
          [identity.subject, family.id],
        );
        await this.audit(
          client,
          family.id,
          identity.subject,
          'telegram.unlinked',
          {},
        );
        return { ok: true };
      }
      if (path === '/state' && method === 'GET')
        return {
          state: normalize(family.state),
          revision: family.state.revision,
          instanceGeneration: family.generation,
          user,
          storage: { provider: 'rds', connected: true },
          lease: null,
        };
      if (path === '/sync/state' && method === 'GET')
        return {
          revision: family.state.revision,
          publishedRevision: family.state.revision,
          instanceGeneration: family.generation,
          storage: { provider: 'rds', connected: true },
          lease: null,
        };
      const ticket = () => ({
        leaseId: session.id,
        fencingToken: family.session_generation,
        editorInstanceId: String(body.editorInstanceId ?? ''),
        ownerUserId: user.id,
        ownerName: user.name,
        expiresAt: this.now() + 90000,
        exclusive: false,
      });
      if (
        ['/edit-lease/acquire', '/edit-lease/heartbeat'].includes(path) &&
        method === 'POST'
      ) {
        editor();
        return { lease: ticket() };
      }
      if (path === '/edit-lease/release' && method === 'POST') {
        editor();
        return { ok: true };
      }
      if (path === '/commands' && method === 'POST') {
        editor();
        return this.commands(client, family, user, body);
      }
      if (path === '/family/rates' && method === 'GET')
        return { rates: await manualRates(client, family.id) };
      if (path === '/family/rates' && method === 'POST') {
        admin();
        check(
          typeof body.from === 'string' &&
            /^[A-Z]{3}$/.test(body.from) &&
            typeof body.to === 'string' &&
            /^[A-Z]{3}$/.test(body.to) &&
            body.from !== body.to &&
            isISODate(body.date) &&
            typeof body.rate === 'string',
          'VALIDATION_FAILED',
        );
        decimalRate(body.rate);
        await client.query(
          'INSERT INTO brownie_manual_rates(family_id,from_currency,to_currency,rate_date,rate,actor,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(family_id,from_currency,to_currency,rate_date) DO UPDATE SET rate=EXCLUDED.rate,actor=EXCLUDED.actor,created_at=EXCLUDED.created_at',
          [
            family.id,
            body.from,
            body.to,
            body.date,
            body.rate,
            identity.subject,
            this.now(),
          ],
        );
        await this.audit(
          client,
          family.id,
          identity.subject,
          'exchange-rate.saved',
          { from: body.from, to: body.to, date: body.date, rate: body.rate },
        );
        return { ok: true };
      }
      if (path.startsWith('/operations/') && method === 'GET') {
        const op = (
          await client.query(
            'SELECT * FROM brownie_family_operations WHERE family_id=$1 AND id=$2',
            [family.id, decodeURIComponent(path.slice('/operations/'.length))],
          )
        ).rows[0];
        check(op, 'OPERATION_NOT_FOUND', 404);
        check(
          op.actor === identity.subject || user.role === 'admin',
          'FORBIDDEN',
          403,
        );
        return {
          operationId: op.id,
          status: 'COMMITTED',
          revision: op.revision,
        };
      }
      if (path === '/sessions' && method === 'GET') {
        const rows = (
          await client.query(
            'SELECT * FROM brownie_family_sessions WHERE family_id=$1 AND ($2::boolean OR subject=$3) ORDER BY created_at DESC',
            [family.id, user.role === 'admin', identity.subject],
          )
        ).rows;
        return {
          sessions: rows.map((s) => ({
            id: s.id,
            userId: s.subject,
            deviceName: s.device_name,
            createdAt: Number(s.created_at),
            expiresAt: Number(s.expires_at),
            revokedAt: s.revoked_at === null ? undefined : Number(s.revoked_at),
            current: s.id === session.id,
            active:
              s.revoked_at === null &&
              Number(s.expires_at) > this.now() &&
              s.generation === family.session_generation,
          })),
        };
      }
      if (/^\/sessions\/[^/]+\/revoke$/.test(path) && method === 'POST') {
        const result = await client.query(
          'UPDATE brownie_family_sessions SET revoked_at=$1 WHERE family_id=$2 AND id=$3 AND ($4::boolean OR subject=$5) RETURNING id',
          [
            this.now(),
            family.id,
            decodeURIComponent(path.split('/')[2]),
            user.role === 'admin',
            identity.subject,
          ],
        );
        check(result.rows.length, 'NOT_FOUND', 404);
        return { ok: true };
      }
      if (path === '/admin/takeover' && method === 'POST') {
        admin();
        await client.query(
          'UPDATE brownie_families SET session_generation=session_generation+1,auth_after=$1 WHERE id=$2',
          [Math.floor(this.now() / 1000), family.id],
        );
        await client.query(
          'UPDATE brownie_family_sessions SET revoked_at=$1 WHERE family_id=$2 AND id<>$3 AND revoked_at IS NULL',
          [this.now(), family.id, session.id],
        );
        await client.query(
          'UPDATE brownie_family_sessions SET generation=$1 WHERE id=$2',
          [++family.session_generation, session.id],
        );
        return { ok: true, lease: ticket(), sessionToken: request.token };
      }
      if (path === '/family/members' && method === 'GET') {
        const rows = (
          await client.query(
            'SELECT m.*,a.email,a.name,a.preferred_locale,l.username AS telegram_username,l.subject AS telegram_linked_subject FROM brownie_memberships m JOIN brownie_accounts a ON a.subject=m.subject LEFT JOIN brownie_telegram_links l ON l.subject=m.subject AND l.family_id=m.family_id WHERE m.family_id=$1 ORDER BY a.name',
            [family.id],
          )
        ).rows;
        const invitations = (
          await client.query(
            'SELECT id,email,person_id,role,expires_at,accepted_at,revoked_at FROM brownie_invitations WHERE family_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$2',
            [family.id, this.now()],
          )
        ).rows;
        return {
          members: rows.map((m) => ({
            ...this.user(
              {
                subject: m.subject,
                email: m.email,
                name: m.name,
                authenticatedAt: 0,
              },
              m,
              family,
              m.preferred_locale,
            ),
            telegram: {
              linked: !!m.telegram_linked_subject,
              ...(m.telegram_username ? { username: m.telegram_username } : {}),
            },
            telegramReportTime: m.telegram_report_time ?? null,
            nextReportAt:
              m.next_telegram_report_at === null
                ? null
                : new Date(Number(m.next_telegram_report_at)).toISOString(),
          })),
          invitations: invitations.map((i) => ({
            id: i.id,
            email: i.email,
            personId: i.person_id,
            role: i.role,
            expiresAt: Number(i.expires_at),
          })),
          invitationsEnabled: !!this.services.sendInvitation,
        };
      }
      if (path === '/family/invitations' && method === 'POST') {
        admin();
        return this.invite(
          client,
          family,
          identity,
          body,
          account.preferred_locale,
        );
      }
      if (/^\/family\/invitations\/[^/]+$/.test(path) && method === 'DELETE') {
        admin();
        await client.query(
          'UPDATE brownie_invitations SET revoked_at=$1 WHERE family_id=$2 AND id=$3',
          [this.now(), family.id, path.split('/')[3]],
        );
        return { ok: true };
      }
      if (/^\/family\/invitations\/[^/]+$/.test(path) && method === 'PATCH') {
        admin();
        check(roles.includes(body.role), 'VALIDATION_FAILED');
        const changed = await client.query(
          'UPDATE brownie_invitations SET role=$1 WHERE family_id=$2 AND id=$3 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$4 RETURNING id',
          [body.role, family.id, path.split('/')[3], this.now()],
        );
        check(changed.rows.length, 'INVITATION_EXPIRED', 409);
        await this.audit(
          client,
          family.id,
          identity.subject,
          'invitation.role-changed',
          { invitationId: path.split('/')[3], role: body.role },
        );
        return { ok: true };
      }
      if (
        /^\/family\/members\/[^/]+\/reminders$/.test(path) &&
        method === 'PATCH'
      ) {
        const subject = decodeURIComponent(path.split('/')[3]);
        check(
          subject === identity.subject || user.role === 'admin',
          'FORBIDDEN',
          403,
        );
        const target = (
          await client.query(
            'SELECT subject FROM brownie_memberships WHERE family_id=$1 AND subject=$2',
            [family.id, subject],
          )
        ).rows[0];
        check(target, 'NOT_FOUND', 404);
        check(
          Object.prototype.hasOwnProperty.call(body, 'telegramReportTime'),
          'VALIDATION_FAILED',
        );
        const reportTime =
          body.telegramReportTime === null
            ? null
            : validateDailyReportTime(body.telegramReportTime);
        const effective = reportTime ?? familyReportTime(family.state as State);
        const next = nextTelegramReportAt(effective, this.now());
        await client.query(
          'UPDATE brownie_memberships SET telegram_report_time=$1::jsonb,next_telegram_report_at=$2 WHERE family_id=$3 AND subject=$4',
          [
            reportTime === null ? null : JSON.stringify(reportTime),
            next,
            family.id,
            subject,
          ],
        );
        await this.audit(
          client,
          family.id,
          identity.subject,
          'telegram.schedule-changed',
          {
            subject,
          },
        );
        return {
          ok: true,
          telegramReportTime: reportTime,
          nextReportAt: new Date(next).toISOString(),
        };
      }
      if (
        /^\/family\/members\/[^/]+$/.test(path) &&
        ['PATCH', 'DELETE'].includes(method)
      ) {
        admin();
        const subject = decodeURIComponent(path.split('/')[3]);
        check(subject !== family.head_subject, 'HEAD_TRANSFER_REQUIRED', 409);
        if (method === 'DELETE')
          await client.query(
            'DELETE FROM brownie_memberships WHERE family_id=$1 AND subject=$2',
            [family.id, subject],
          );
        else {
          check(roles.includes(body.role), 'VALIDATION_FAILED');
          await client.query(
            'UPDATE brownie_memberships SET role=$1 WHERE family_id=$2 AND subject=$3',
            [body.role, family.id, subject],
          );
        }
        await client.query(
          'UPDATE brownie_family_sessions SET revoked_at=$1 WHERE family_id=$2 AND subject=$3',
          [this.now(), family.id, subject],
        );
        await this.audit(
          client,
          family.id,
          identity.subject,
          'membership.changed',
          { subject, method },
        );
        return { ok: true };
      }
      if (path === '/family/transfer' && method === 'POST') {
        admin();
        check(
          typeof body.subject === 'string' && body.subject !== identity.subject,
          'VALIDATION_FAILED',
        );
        check(
          (
            await client.query(
              'SELECT subject FROM brownie_memberships WHERE family_id=$1 AND subject=$2',
              [family.id, body.subject],
            )
          ).rows.length,
          'NOT_FOUND',
          404,
        );
        await client.query(
          'UPDATE brownie_families SET head_subject=$1 WHERE id=$2',
          [body.subject, family.id],
        );
        await this.audit(
          client,
          family.id,
          identity.subject,
          'head.transferred',
          { subject: body.subject },
        );
        return { ok: true };
      }
      if (path === '/family/leave' && method === 'POST') {
        check(body.confirm === true, 'VALIDATION_FAILED');
        if (user.role === 'admin') {
          const others = (
            await client.query(
              'SELECT subject FROM brownie_memberships WHERE family_id=$1 AND subject<>$2 ORDER BY subject',
              [family.id, identity.subject],
            )
          ).rows;
          if (others.length)
            await client.query(
              'UPDATE brownie_families SET head_subject=$1 WHERE id=$2',
              [others[randomInt(others.length)].subject, family.id],
            );
          else {
            // Mark deleted before background S3 purging. New users cannot enter an abandoned family.
            await client.query(
              "UPDATE brownie_families SET deleted_at=$1,state='{}'::jsonb WHERE id=$2",
              [this.now(), family.id],
            );
            await client.query(
              'UPDATE brownie_invitations SET revoked_at=$1 WHERE family_id=$2 AND revoked_at IS NULL',
              [this.now(), family.id],
            );
          }
        }
        await client.query('DELETE FROM brownie_memberships WHERE subject=$1', [
          identity.subject,
        ]);
        await client.query(
          'UPDATE brownie_family_sessions SET revoked_at=$1 WHERE subject=$2 AND family_id=$3',
          [this.now(), identity.subject, family.id],
        );
        await this.audit(
          client,
          family.id,
          identity.subject,
          'membership.left',
          {},
        );
        return { ok: true, onboarding: true };
      }
      if (path === '/admin/backups/status' && method === 'GET') {
        admin();
        return {
          enabled: !!this.services.backups,
          automaticEnabled: !!this.services.backups,
          mode: 'daily',
          storage: 's3',
          lastSuccessAt:
            family.last_backup_at === null
              ? undefined
              : Number(family.last_backup_at),
          error: family.maintenance_error ?? undefined,
        };
      }
      if (path === '/admin/delete/status' && method === 'GET') {
        admin();
        return { phase: 'NOT_SCHEDULED', supported: false };
      }
      throw new ApiError('NOT_FOUND', 404);
    });
  }
  private user(identity: Identity, m: any, f: any, preferredLocale?: unknown) {
    return {
      id: identity.subject,
      login: identity.email,
      email: identity.email,
      name: identity.name,
      displayName: identity.name,
      personId: m.person_id,
      role: f.head_subject === identity.subject ? 'admin' : m.role,
      enabled: true,
      familyId: f.id,
      preferredLocale: isAppLocale(preferredLocale)
        ? preferredLocale
        : undefined,
    };
  }
  private sessionInfo(f: any, user: any) {
    return {
      initialized: true,
      onboarding: false,
      user,
      localMode: false,
      instanceId: f.id,
      authProvider: 'cognito-google',
      instanceGeneration: f.generation,
      revision: f.state.revision,
    };
  }
  private async authenticate(
    c: SqlClient,
    i: Identity,
    f: any,
    token?: string,
  ) {
    check(token && /^[A-Za-z0-9_-]{43}$/.test(token), 'AUTH_REQUIRED', 401);
    const s = (
      await c.query(
        'SELECT * FROM brownie_family_sessions WHERE token_hash=$1 AND subject=$2 AND family_id=$3',
        [digest(token), i.subject, f.id],
      )
    ).rows[0];
    check(
      s &&
        s.revoked_at === null &&
        Number(s.expires_at) > this.now() &&
        s.generation === f.session_generation,
      'SESSION_REVOKED',
      401,
    );
    // Active sessions slide only after all revocation/generation checks have passed.
    if (Number(s.expires_at) - this.now() < 6 * 3600000) {
      s.expires_at = this.now() + 12 * 3600000;
      await c.query(
        'UPDATE brownie_family_sessions SET expires_at=$1 WHERE id=$2',
        [s.expires_at, s.id],
      );
    }
    return s;
  }
  private async login(c: SqlClient, i: Identity, f: any, user: any, body: any) {
    check(
      i.authenticatedAt > Number(f.auth_after),
      'FRESH_GOOGLE_LOGIN_REQUIRED',
      401,
    );
    const token = sessionToken(),
      now = this.now();
    await c.query(
      'DELETE FROM brownie_family_sessions WHERE subject=$1 AND expires_at<$2',
      [i.subject, now],
    );
    await c.query(
      'INSERT INTO brownie_family_sessions(id,token_hash,subject,family_id,generation,created_at,expires_at,device_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        digest(token),
        i.subject,
        f.id,
        f.session_generation,
        now,
        now + 12 * 3600000,
        String(body.deviceName ?? 'Browser').slice(0, 80),
      ],
    );
    return { ...this.sessionInfo(f, user), sessionToken: token };
  }
  private async create(c: SqlClient, i: Identity, body: any) {
    check(
      !(
        await c.query(
          'SELECT subject FROM brownie_memberships WHERE subject=$1',
          [i.subject],
        )
      ).rows.length,
      'ALREADY_IN_FAMILY',
      409,
    );
    check(
      typeof body.name === 'string' &&
        body.name.trim().length > 0 &&
        body.name.length <= 100,
      'VALIDATION_FAILED',
    );
    const id = randomUUID(),
      personId = randomUUID();
    const state = applyCommands(
      createEmptyState(),
      [
        {
          type: 'UpdateHousehold',
          payload: {
            name: body.name.trim(),
            currency: body.currency ?? 'EUR',
            timezone: body.timezone ?? 'Europe/Prague',
            locale: body.locale ?? 'ru',
          },
        },
        { type: 'AddPerson', payload: { id: personId, displayName: i.name } },
      ],
      {
        actorUserId: i.subject,
        operationId: randomUUID(),
        now: new Date(this.now()).toISOString(),
      },
    );
    state.household.id = id;
    const family = (
      await c.query(
        'INSERT INTO brownie_families(id,head_subject,state,generation,created_at) VALUES($1,$2,$3::jsonb,$4,$5) RETURNING *',
        [id, i.subject, JSON.stringify(state), randomUUID(), this.now()],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO brownie_memberships(subject,family_id,person_id,role) VALUES($1,$2,$3,'deleter')",
      [i.subject, id, personId],
    );
    await syncMemberTelegramSchedule(c, id, state, this.now(), {
      subject: i.subject,
    });
    await this.audit(c, id, i.subject, 'family.created', {});
    return this.login(
      c,
      i,
      family,
      this.user(i, { person_id: personId }, family),
      body,
    );
  }
  private async commands(c: SqlClient, f: any, user: any, body: any) {
    check(body.protocolVersion === 1, 'CLIENT_UPGRADE_REQUIRED', 409);
    check(
      typeof body.operationId === 'string' &&
        body.operationId.length >= 10 &&
        body.operationId.length <= 150 &&
        Number.isSafeInteger(body.expectedRevision) &&
        Array.isArray(body.commands) &&
        body.commands.length > 0 &&
        body.commands.length <= 1000,
      'VALIDATION_FAILED',
    );
    for (const command of body.commands) {
      check(command && typeof command.type === 'string', 'VALIDATION_FAILED');
    }
    const hash = digest(
      canonical({
        generation: body.instanceGeneration,
        expectedRevision: body.expectedRevision,
        commands: body.commands,
      }),
    );
    const existing = (
      await c.query(
        'SELECT * FROM brownie_family_operations WHERE family_id=$1 AND id=$2',
        [f.id, body.operationId],
      )
    ).rows[0];
    if (existing) {
      check(existing.actor === user.id, 'FORBIDDEN', 403);
      check(existing.request_hash === hash, 'IDEMPOTENCY_MISMATCH', 409);
      return {
        operationId: existing.id,
        status: 'COMMITTED',
        revision: existing.revision,
      };
    }
    check(body.instanceGeneration === f.generation, 'GENERATION_MISMATCH', 409);
    check(body.expectedRevision === f.state.revision, 'REVISION_CONFLICT', 409);
    const before = normalize(f.state),
      overrides = await manualRates(c, f.id);
    // Freeze compatibility defaults before a command can add/remove an automatic
    // schedule. Otherwise the same legacy obligation would silently change its
    // reminder policy as a side effect of that schedule edit.
    for (const obligation of before.obligations)
      obligation.reminder ??= effectiveReminderSettings(before, obligation);
    authorizeFamilyCommands(before, body.commands, user);
    const now = new Date(this.now()),
      backfill = body.commands.some(
        (command: Command) =>
          command.type === 'AddAutomaticPayment' &&
          command.payload.schedule.enabled,
      );
    check(!backfill || body.commands.length < 1000, 'VALIDATION_FAILED');
    const commands: Command[] = backfill
      ? [
          ...body.commands,
          {
            type: 'ExecuteAutomaticPayments',
            payload: { through: householdToday(before, now) },
          },
        ]
      : body.commands;
    const exchangeRates = this.services.quotes
      ? await this.services.quotes(before, commands, overrides)
      : overrides;
    const after = applyCommands(before, commands, {
      actorUserId: user.id,
      operationId: body.operationId,
      now: now.toISOString(),
      allowAutomaticPayments: true,
      exchangeRates,
    });
    check(
      Buffer.byteLength(JSON.stringify(after)) <= 4 * 1024 * 1024,
      'FAMILY_SIZE_LIMIT',
      413,
    );
    await c.query('UPDATE brownie_families SET state=$1::jsonb WHERE id=$2', [
      JSON.stringify(after),
      f.id,
    ]);
    if (
      JSON.stringify(familyReportTime(before)) !==
      JSON.stringify(familyReportTime(after))
    )
      await syncMemberTelegramSchedule(c, f.id, after, this.now(), {
        inheritingOnly: true,
      });
    await c.query(
      'INSERT INTO brownie_family_operations(family_id,id,actor,request_hash,revision,committed_at) VALUES($1,$2,$3,$4,$5,$6)',
      [f.id, body.operationId, user.id, hash, after.revision, this.now()],
    );
    return {
      operationId: body.operationId,
      status: 'COMMITTED',
      revision: after.revision,
    };
  }
  private async invite(
    c: SqlClient,
    f: any,
    i: Identity,
    body: any,
    inviterLocale?: unknown,
  ) {
    check(this.services.sendInvitation, 'INVITATION_EMAIL_NOT_CONFIGURED', 503);
    const recent = (
      await c.query(
        'SELECT count(*) AS count FROM brownie_invitations WHERE family_id=$1 AND created_at>$2',
        [f.id, this.now() - 86400000],
      )
    ).rows[0];
    check(Number(recent.count) < 20, 'INVITATION_LIMIT', 429);
    const email = String(body.email ?? '')
      .trim()
      .toLowerCase();
    check(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
        email.length <= 254 &&
        roles.includes(body.role),
      'VALIDATION_FAILED',
    );
    check(
      typeof body.personId === 'string' &&
        f.state.people.some(
          (p: any) => p.id === body.personId && !p.archivedAt,
        ),
      'VALIDATION_FAILED',
    );
    check(
      !(
        await c.query(
          'SELECT subject FROM brownie_memberships WHERE family_id=$1 AND person_id=$2',
          [f.id, body.personId],
        )
      ).rows.length,
      'PERSON_ALREADY_LINKED',
      409,
    );
    const id = randomUUID(),
      token = sessionToken(),
      expiresAt = this.now() + 7 * 86400000;
    const recipient = (
      await c.query(
        'SELECT preferred_locale FROM brownie_accounts WHERE email=$1',
        [email],
      )
    ).rows[0];
    const locale = normalizeAppLocale(
      recipient?.preferred_locale,
      normalizeAppLocale(
        inviterLocale,
        normalizeAppLocale(f.state.household.locale, 'en'),
      ),
    );
    await c.query(
      'UPDATE brownie_invitations SET revoked_at=$1 WHERE family_id=$2 AND (email=$3 OR person_id=$4) AND accepted_at IS NULL AND revoked_at IS NULL',
      [this.now(), f.id, email, body.personId],
    );
    await c.query(
      'INSERT INTO brownie_invitations(id,family_id,token_hash,email,person_id,role,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        f.id,
        digest(token),
        email,
        body.personId,
        body.role,
        this.now(),
        expiresAt,
      ],
    );
    const url = new URL('/', this.services.appOrigin);
    url.hash = new URLSearchParams({ invite: token }).toString();
    // Queue before commit: a failed queue rolls back the invitation. A rolled-back link has no authority.
    await this.services.sendInvitation({
      id,
      familyId: f.id,
      email,
      familyName: f.state.household.name,
      url: url.toString(),
      expiresAt,
      locale,
    });
    await this.audit(c, f.id, i.subject, 'invitation.created', {
      email,
      personId: body.personId,
      role: body.role,
    });
    return { ok: true, id, expiresAt };
  }
  private async accept(c: SqlClient, i: Identity, body: any) {
    check(
      typeof body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token),
      'INVITATION_INVALID',
      400,
    );
    check(
      !(
        await c.query(
          'SELECT subject FROM brownie_memberships WHERE subject=$1',
          [i.subject],
        )
      ).rows.length,
      'ALREADY_IN_FAMILY',
      409,
    );
    const invitation = (
      await c.query('SELECT * FROM brownie_invitations WHERE token_hash=$1', [
        digest(body.token),
      ])
    ).rows[0];
    check(
      invitation && invitation.email === i.email,
      'INVITATION_INVALID',
      403,
    );
    const family = (
      await c.query('SELECT * FROM brownie_families WHERE id=$1 FOR UPDATE', [
        invitation.family_id,
      ])
    ).rows[0];
    check(family && !family.deleted_at, 'INVITATION_INVALID', 410);
    const fresh = (
      await c.query('SELECT * FROM brownie_invitations WHERE id=$1', [
        invitation.id,
      ])
    ).rows[0];
    check(
      fresh.accepted_at === null &&
        fresh.revoked_at === null &&
        Number(fresh.expires_at) > this.now(),
      'INVITATION_EXPIRED',
      410,
    );
    check(
      !(
        await c.query(
          'SELECT subject FROM brownie_memberships WHERE family_id=$1 AND person_id=$2',
          [family.id, fresh.person_id],
        )
      ).rows.length,
      'PERSON_ALREADY_LINKED',
      409,
    );
    await c.query(
      'INSERT INTO brownie_memberships(subject,family_id,person_id,role) VALUES($1,$2,$3,$4)',
      [i.subject, family.id, fresh.person_id, fresh.role],
    );
    await syncMemberTelegramSchedule(c, family.id, family.state, this.now(), {
      subject: i.subject,
    });
    await c.query('UPDATE brownie_invitations SET accepted_at=$1 WHERE id=$2', [
      this.now(),
      fresh.id,
    ]);
    await this.audit(c, family.id, i.subject, 'invitation.accepted', {
      invitationId: fresh.id,
    });
    return this.login(c, i, family, this.user(i, fresh, family), body);
  }
  private async audit(
    c: SqlClient,
    family: string,
    actor: string,
    action: string,
    details: unknown,
  ) {
    await c.query(
      'INSERT INTO brownie_family_audit(id,family_id,actor,action,created_at,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [
        randomUUID(),
        family,
        actor,
        action,
        this.now(),
        JSON.stringify(details),
      ],
    );
  }
}
export async function manualRates(
  c: SqlClient,
  familyId: string,
): Promise<ExchangeRate[]> {
  const rows = (
    await c.query('SELECT * FROM brownie_manual_rates WHERE family_id=$1', [
      familyId,
    ])
  ).rows;
  return rows.map((row) => ({
    from: row.from_currency,
    to: row.to_currency,
    date: row.rate_date,
    rate: row.rate,
    source: 'manual',
  }));
}
