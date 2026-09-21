import { randomUUID } from 'node:crypto';
import {
  addDays,
  applyCommands,
  householdToday,
  type Command,
  type State,
} from '../domain';
import type { Database } from './database';
import { manualRates, type FamilyServices } from './families';
import { retainedBackupKeys } from './maintenance';
import { check, ApiError } from './identity';

/** Bounded work, one independently committed transaction per family. A retry cannot duplicate payments. */
export async function runFamilyMaintenance(
  database: Database,
  services: FamilyServices,
) {
  const now = services.clock?.() ?? Date.now();
  const started = Date.now();
  const families = await database.transaction(
    async (c) =>
      (
        await c.query(
          'SELECT id FROM brownie_families ORDER BY COALESCE(last_maintenance_at,0),created_at LIMIT 20',
        )
      ).rows,
  );
  const results: Array<{ familyId: string; status: string }> = [];
  for (const item of families) {
    try {
      const result = await database.transaction(async (c) => {
        const f = (
          await c.query(
            'SELECT * FROM brownie_families WHERE id=$1 FOR UPDATE SKIP LOCKED',
            [item.id],
          )
        ).rows[0];
        if (!f) return 'busy';
        await c.query(
          'UPDATE brownie_families SET last_maintenance_at=$1 WHERE id=$2',
          [now, f.id],
        );
        const backup = services.backups?.(f.id);
        if (f.deleted_at !== null) {
          if (backup) {
            check(backup.purgeBatch, 'BACKUP_STORAGE_NOT_CONFIGURED', 503);
            if (!(await backup.purgeBatch()).complete) return 'deleting';
          }
          await c.query('DELETE FROM brownie_families WHERE id=$1', [f.id]);
          return 'deleted';
        }
        const before = f.state as State;
        if (before.automaticPayments?.some((s) => s.enabled)) {
          const today = householdToday(before, new Date(now));
          const commands: Command[] = [
            { type: 'ExecuteAutomaticPayments', payload: { through: today } },
          ];
          const overrides = await manualRates(c, f.id);
          const exchangeRates = services.quotes
            ? await services.quotes(before, commands, overrides)
            : overrides;
          const after = applyCommands(before, commands, {
            actorUserId: 'system',
            operationId: randomUUID(),
            now: new Date(now).toISOString(),
            allowAutomaticPayments: true,
            exchangeRates,
          });
          // Domain may append an audit event for a no-op. Do not create daily backups from scheduler-only noise.
          const changed =
            after.periods.length !== before.periods.length ||
            after.payments.length !== before.payments.length ||
            (after.automaticPaymentRuns?.length ?? 0) !==
              (before.automaticPaymentRuns?.length ?? 0) ||
            JSON.stringify(after.allocations) !==
              JSON.stringify(before.allocations);
          if (changed) {
            await c.query(
              'UPDATE brownie_families SET state=$1::jsonb WHERE id=$2',
              [JSON.stringify(after), f.id],
            );
            f.state = after;
          }
        }
        if (!backup) return 'disabled';
        const sameDay =
          f.last_backup_at !== null &&
          new Date(Number(f.last_backup_at)).toISOString().slice(0, 10) ===
            new Date(now).toISOString().slice(0, 10);
        if (sameDay || f.last_backup_revision === f.state.revision)
          return 'unchanged';
        const saved = await backup.save(f.state);
        check(saved.verified, 'BACKUP_VERIFICATION_FAILED', 503);
        await c.query(
          'INSERT INTO brownie_family_backups(id,family_id,created_at,revision) VALUES($1,$2,$3,$4)',
          [saved.fileId, f.id, now, f.state.revision],
        );
        await c.query(
          'UPDATE brownie_families SET last_backup_at=$1,last_backup_revision=$2,maintenance_error=NULL WHERE id=$3',
          [now, f.state.revision, f.id],
        );
        const records = (
          await c.query(
            'SELECT * FROM brownie_family_backups WHERE family_id=$1 ORDER BY created_at DESC',
            [f.id],
          )
        ).rows;
        const keep = retainedBackupKeys(records);
        if (backup.remove)
          for (const record of records)
            if (!keep.has(record.id)) {
              await backup.remove(record.id);
              await c.query(
                'DELETE FROM brownie_family_backups WHERE id=$1 AND family_id=$2',
                [record.id, f.id],
              );
            }
        return 'created';
      });
      results.push({ familyId: item.id, status: result });
    } catch (error) {
      const code =
        error instanceof ApiError ? error.code : 'MAINTENANCE_FAILED';
      await database.transaction(async (c) => {
        await c.query(
          'UPDATE brownie_families SET maintenance_error=$1,last_maintenance_at=$2 WHERE id=$3',
          [code, now, item.id],
        );
      });
      results.push({ familyId: item.id, status: code });
    }
    if (Date.now() - started > 15000) break;
  }
  return { results };
}
