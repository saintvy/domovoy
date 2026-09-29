import { describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../src/aws/local-database';
import { familySchema } from '../src/aws/family-schema';
import { createEmptyState } from '../src/domain';

describe('historical price membership migration', () => {
  it('adds a denied-by-default grant to existing memberships and can be rerun', async () => {
    const local = await createLocalDatabase();
    try {
      await local.postgres.query(
        "INSERT INTO brownie_accounts(subject,email,name) VALUES('legacy','legacy@example.test','Legacy')",
      );
      await local.postgres.query(
        "INSERT INTO brownie_families(id,head_subject,state,generation,created_at) VALUES('legacy-family','legacy',$1::jsonb,'generation',0)",
        [JSON.stringify(createEmptyState())],
      );
      await local.postgres.query(
        "INSERT INTO brownie_memberships(subject,family_id,person_id,role) VALUES('legacy','legacy-family','legacy-person','deleter')",
      );
      await local.postgres.exec(
        'ALTER TABLE brownie_memberships DROP COLUMN can_edit_historical_prices',
      );
      await local.postgres.exec(familySchema);
      await local.postgres.exec(familySchema);
      const row = await local.postgres.query(
        "SELECT can_edit_historical_prices FROM brownie_memberships WHERE subject='legacy'",
      );
      expect(
        (row.rows[0] as { can_edit_historical_prices: boolean })
          .can_edit_historical_prices,
      ).toBe(false);
    } finally {
      await local.postgres.close();
    }
  }, 45_000);
});
