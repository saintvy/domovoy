import { resolve } from 'node:path';
import {
  EcbRates,
  parseEcbHistory,
  type RateYear,
} from '../src/aws/exchange-rates';
import { ApiError } from '../src/aws/identity';
import type { FamilyServices } from '../src/aws/families';
import { LocalBackups } from './local-backups';
import { localOrigin } from './local-config';

/** Local financial data and backups stay on this computer; only public ECB rates are fetched. */
export function createLocalFamilyServices(): FamilyServices {
  let cached: { at: number; years: Map<string, RateYear> } | undefined;
  let pending: Promise<Map<string, RateYear>> | undefined;
  const rates = new EcbRates(
    async (year) => {
      if (!cached || Date.now() - cached.at > 900000) {
        pending ??= (async () => {
          const response = await fetch(
            'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml',
            { signal: AbortSignal.timeout(15000) },
          );
          if (
            !response.ok ||
            Number(response.headers.get('content-length') ?? 0) >
              20 * 1024 * 1024
          )
            throw new ApiError('EXCHANGE_RATE_REQUIRED', 409);
          const text = await response.text();
          if (Buffer.byteLength(text) > 20 * 1024 * 1024)
            throw new ApiError('EXCHANGE_RATE_REQUIRED', 409);
          return parseEcbHistory(text);
        })().finally(() => {
          pending = undefined;
        });
        cached = { at: Date.now(), years: await pending };
      }
      return cached.years.get(year) ?? [];
    },
    Date.now,
    async () => !cached || Date.now() - cached.at > 900000,
  );
  return {
    appOrigin: localOrigin,
    quotes: (state, commands) => rates.quotes(state, commands),
    backups: (familyId) => {
      if (!/^[0-9a-f-]{36}$/i.test(familyId))
        throw new ApiError('INVALID_FAMILY_ID', 400);
      return new LocalBackups(resolve('tmp/local-backups', familyId));
    },
  };
}
