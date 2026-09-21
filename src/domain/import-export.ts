import type { Payment, State } from './types';
import { paymentFingerprint, stableId, validateState } from './core';
import { ensure, isISODate } from './validation';

const currencyDigitsCache = new Map<string, number>();
export function currencyMinorDigits(currency = 'CZK'): number {
  let digits = currencyDigitsCache.get(currency);
  if (digits === undefined) {
    ensure(
      /^[A-Z]{3}$/.test(currency),
      'INVALID_CURRENCY',
      'Неверный код валюты',
    );
    digits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits!;
    currencyDigitsCache.set(currency, digits);
  }
  return digits;
}
export function parseMoney(input: string, currency = 'CZK'): number {
  const digits = currencyMinorDigits(currency),
    normalized = input
      .trim()
      .replace(/[\s\u00a0]/g, '')
      .replace(',', '.');
  ensure(
    (digits ? new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`) : /^\d+$/).test(
      normalized,
    ),
    'INVALID_MONEY',
    `Введите положительную сумму, не более ${digits} знаков после запятой`,
  );
  const [whole, fraction = ''] = normalized.split('.');
  const value =
    BigInt(whole) * 10n ** BigInt(digits) +
    BigInt(fraction.padEnd(digits, '0') || '0');
  ensure(
    value <= BigInt(Number.MAX_SAFE_INTEGER),
    'MONEY_RANGE',
    'Сумма слишком велика',
  );
  return Number(value);
}
export function moneyInputValue(amount: number, currency = 'CZK'): string {
  ensure(
    Number.isSafeInteger(amount),
    'MONEY_RANGE',
    'Сумма выходит за безопасный диапазон',
  );
  const digits = currencyMinorDigits(currency),
    negative = amount < 0,
    value = BigInt(negative ? -amount : amount),
    factor = 10n ** BigInt(digits);
  return `${negative ? '-' : ''}${value / factor}${digits ? '.' + String(value % factor).padStart(digits, '0') : ''}`;
}
export function formatMoney(
  amount: number,
  currency = 'CZK',
  locale = 'ru',
): string {
  ensure(
    Number.isSafeInteger(amount),
    'MONEY_RANGE',
    'Сумма выходит за безопасный диапазон',
  );
  const digits = currencyMinorDigits(currency),
    value = BigInt(amount < 0 ? -amount : amount),
    factor = 10n ** BigInt(digits),
    whole = value / factor,
    formatValue = amount < 0 ? (whole === 0n ? -0 : -whole) : whole;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
    .formatToParts(formatValue)
    .map((part) =>
      part.type === 'fraction'
        ? String(value % factor).padStart(digits, '0')
        : part.value,
    )
    .join('');
}
export interface CsvPreviewRow {
  rowNumber: number;
  payment?: Payment;
  duplicate: boolean;
  possibleDuplicate: boolean;
  errors: string[];
}
export interface CsvPreview {
  rows: CsvPreviewRow[];
  validCount: number;
  duplicateCount: number;
  errorCount: number;
  columns: string[];
}
/** Quoted fields, escaped quotes, embedded newlines, CRLF and UTF-8 BOM are supported. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  delimiter ??= text.split(/\r?\n/, 1)[0].includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"') {
      ensure(
        !field && !closed,
        'INVALID_CSV',
        'Кавычка внутри неэкранированного поля',
      );
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      closed = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      field = '';
      closed = false;
    } else {
      ensure(
        !closed || c === ' ',
        'INVALID_CSV',
        'Текст после закрывающей кавычки',
      );
      if (!closed) field += c;
    }
  }
  ensure(!quoted, 'INVALID_CSV', 'Не закрыта кавычка CSV');
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
export function previewCsv(
  text: string,
  state: State,
  payerPersonId: string,
): CsvPreview {
  ensure(
    text.length <= 1024 * 1024,
    'IMPORT_TOO_LARGE',
    'Размер CSV не должен превышать 1 МиБ',
  );
  const parsed = parseCsv(text);
  ensure(parsed.length > 0, 'EMPTY_CSV', 'CSV пуст');
  const columns = parsed[0].map((x) => x.trim().toLowerCase());
  const aliases: Record<string, string[]> = {
    date: ['date', 'paidat', 'дата'],
    amount: ['amount', 'сумма'],
    currency: ['currency', 'валюта'],
    description: ['description', 'descriptor', 'описание'],
    reference: ['reference', 'externalref', 'идентификатор'],
    account: ['account', 'sourceaccountid', 'счёт', 'счет'],
  };
  const idx = (name: string) =>
    columns.findIndex((c) => aliases[name].includes(c));
  ensure(
    idx('date') >= 0 && idx('amount') >= 0,
    'CSV_COLUMNS',
    'Нужны колонки date и amount (или дата и сумма)',
  );
  const seen = new Set(state.payments.map((x) => paymentFingerprint(x)));
  const seenIds = new Set(state.payments.map((x) => x.id));
  const fileFingerprint = stableId(text);
  const refs = new Set(
    state.payments
      .filter((p) => p.externalRef)
      .map((p) =>
        JSON.stringify([p.source, p.sourceAccountId ?? '', p.externalRef]),
      ),
  );
  const rows = parsed.slice(1).map((cells, n): CsvPreviewRow => {
    const result: CsvPreviewRow = {
      rowNumber: n + 2,
      duplicate: false,
      possibleDuplicate: false,
      errors: [],
    };
    const get = (name: string) => cells[idx(name)]?.trim() ?? '';
    try {
      ensure(
        cells.length === columns.length,
        'CSV_COLUMNS',
        'Число полей отличается от заголовка',
      );
      const paidAt = get('date');
      ensure(
        isISODate(paidAt),
        'INVALID_DATE',
        'Дата должна иметь формат YYYY-MM-DD',
      );
      const currency = (
        get('currency') || state.household.currency
      ).toUpperCase();
      ensure(
        (state.household.currencies ?? [state.household.currency]).includes(
          currency,
        ),
        'CURRENCY_MISMATCH',
        `Валюта ${currency} не добавлена в настройки семьи`,
      );
      const amount = parseMoney(get('amount'), currency);
      ensure(
        amount > 0,
        'INVALID_AMOUNT',
        'Импортирует только положительные расходы; возвраты оформляйте отдельно',
      );
      const p: Payment = {
        id: stableId(`csv:${fileFingerprint}:${n}`),
        paidAt,
        amount,
        currency,
        payerPersonId,
        source: 'csv',
        descriptor: get('description'),
        ...(get('reference') ? { externalRef: get('reference') } : {}),
        ...(get('account') ? { sourceAccountId: get('account') } : {}),
      };
      p.importFingerprint = paymentFingerprint(p);
      result.payment = p;
      const ref = JSON.stringify([
        p.source,
        p.sourceAccountId ?? '',
        p.externalRef,
      ]);
      result.duplicate =
        seenIds.has(p.id) || Boolean(p.externalRef && refs.has(ref));
      result.possibleDuplicate =
        !result.duplicate && !p.externalRef && seen.has(p.importFingerprint);
      seen.add(p.importFingerprint);
      seenIds.add(p.id);
      if (p.externalRef) refs.add(ref);
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : 'Некорректная строка',
      );
    }
    return result;
  });
  return {
    rows,
    columns,
    validCount: rows.filter((x) => !x.errors.length && !x.duplicate).length,
    duplicateCount: rows.filter((x) => x.duplicate).length,
    errorCount: rows.filter((x) => x.errors.length).length,
  };
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}
export async function checksum(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export interface StateExport {
  format: 'domovoy-export';
  schemaVersion: 1;
  exportedAt: string;
  checksum: string;
  state: State;
}
export async function exportState(
  state: State,
  now = new Date().toISOString(),
): Promise<StateExport> {
  const validated = validateState(state);
  return {
    format: 'domovoy-export',
    schemaVersion: 1,
    exportedAt: now,
    checksum: await checksum(validated),
    state: validated,
  };
}
export async function validateExport(input: unknown): Promise<State> {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  ensure(
    data && data.format === 'domovoy-export' && data.schemaVersion === 1,
    'INVALID_EXPORT',
    'Неподдерживаемый формат экспорта',
  );
  ensure(
    (await checksum(data.state)) === data.checksum,
    'CHECKSUM_MISMATCH',
    'Контрольная сумма не совпадает',
  );
  return validateState(data.state);
}
export function exportPaymentsCsv(state: State): string {
  const escape = (v: string) => {
    const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(v) ? `'${v}` : v;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [
    ['date', 'amount', 'currency', 'description', 'reference', 'account'],
    ...state.payments.map((p) => [
      p.paidAt,
      moneyInputValue(p.amount, p.currency),
      p.currency,
      p.descriptor ?? '',
      p.externalRef ?? '',
      p.sourceAccountId ?? '',
    ]),
  ]
    .map((row) => row.map(escape).join(';'))
    .join('\r\n');
}
