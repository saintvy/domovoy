import { useMemo, useState, type FormEvent } from 'react';
import {
  addMonths,
  formatMoney,
  generatePeriods,
  lockedBillingPeriodIds,
  moneyInputValue,
  parseMoney,
  previewBillingRuleChange,
  type BillingPeriod,
  type BillingRule,
  type Command,
  type Obligation,
  type State,
} from '../domain';
import { availableCurrencies, type Translate } from './ProductPanels';
import './price-management.css';

type Props = {
  state: State;
  obligation: Obligation;
  today: string;
  t: Translate;
  close: () => void;
};
const cadenceName = (cadence: string, t: Translate) =>
  ({
    weekly: t('Еженедельно', 'Weekly'),
    monthly: t('Ежемесячно', 'Monthly'),
    quarterly: t('Ежеквартально', 'Quarterly'),
    yearly: t('Ежегодно', 'Yearly'),
  })[cadence] ?? cadence;

export function PriceChangeEditor({
  state,
  obligation,
  today,
  t,
  close,
  period,
  busy,
  submit,
}: Props & {
  period?: BillingPeriod;
  busy: boolean;
  submit: (commands: Command[], label: string) => Promise<void>;
}) {
  const lockedIds = useMemo(() => lockedBillingPeriodIds(state), [state]);
  const candidates = useMemo(() => {
    const forecast = generatePeriods(
      state,
      today.slice(0, 7) + '-01',
      addMonths(today, 24),
    );
    return [
      ...new Map(
        [...forecast, ...state.periods, ...(period ? [period] : [])]
          .filter((p) => p.obligationId === obligation.id)
          .map((p) => [p.id, p]),
      ).values(),
    ].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  }, [state, obligation.id, today, period]);
  const initial =
    period && !lockedIds.has(period.id)
      ? period
      : (candidates.find((p) => p.dueDate >= today && !lockedIds.has(p.id)) ??
        candidates.find((p) => !lockedIds.has(p.id)));
  const [periodId, setPeriodId] = useState(initial?.id ?? '');
  const chosen = candidates.find((p) => p.id === periodId);
  const previous =
    state.rules.find((r) => r.id === chosen?.ruleVersionId) ??
    state.rules
      .filter((r) => r.obligationId === obligation.id && !r.superseded)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const [amount, setAmount] = useState(
    previous?.amount === undefined
      ? ''
      : moneyInputValue(previous.amount, previous.currency),
  );
  const [currency, setCurrency] = useState(
    previous?.currency ?? state.household.currency,
  );
  const [cadence, setCadence] = useState(previous?.cadence ?? 'monthly');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{
    rule: BillingRule;
    fromPeriodId?: string;
    changedPeriodIds: string[];
    preservedPeriodIds: string[];
    supersededRuleIds: string[];
  }>();
  function selectPeriod(value: string) {
    setPeriodId(value);
    setPreview(undefined);
    setError('');
    const selected = candidates.find((p) => p.id === value),
      rule = state.rules.find((r) => r.id === selected?.ruleVersionId);
    if (rule) {
      setAmount(
        rule.amount === undefined
          ? ''
          : moneyInputValue(rule.amount, rule.currency),
      );
      setCurrency(rule.currency);
      setCadence(rule.cadence);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      if (!chosen || !previous)
        throw new Error(t('Выберите начисление.', 'Select a billing period.'));
      if (preview) {
        await submit(
          [
            {
              type: 'ChangeBillingRule',
              payload: {
                rule: preview.rule,
                ...(preview.fromPeriodId
                  ? { fromPeriodId: preview.fromPeriodId }
                  : {}),
              },
            },
          ],
          t('Изменение стоимости', 'Price change'),
        );
        return;
      }
      const rule: BillingRule = {
        ...previous,
        id: crypto.randomUUID(),
        effectiveFrom: chosen.periodStart,
        effectiveTo: undefined,
        amount: parseMoney(amount, currency),
        currency,
        cadence,
        anchor:
          cadence === previous.cadence ? previous.anchor : chosen.periodStart,
      };
      const fromPeriodId = state.periods.some((p) => p.id === chosen.id)
        ? chosen.id
        : undefined;
      const result = previewBillingRuleChange(state, rule, fromPeriodId);
      setPreview({
        rule: result.rule,
        fromPeriodId,
        changedPeriodIds: result.changedPeriodIds,
        preservedPeriodIds: result.preservedPeriodIds,
        supersededRuleIds: result.supersededRuleIds,
      });
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  return (
    <>
      <h2 id="modal-title">{t('Изменение стоимости', 'Change price')}</h2>
      <p className="modal-subtitle">{obligation.title}</p>
      <form onSubmit={save}>
        <label className="field">
          <span>
            {t('Начиная с начисления', 'Starting with billing period')}
          </span>
          <select
            aria-label={t(
              'Начиная с начисления',
              'Starting with billing period',
            )}
            value={periodId}
            onChange={(e) => selectPeriod(e.target.value)}
            required
          >
            {!initial && (
              <option value="">
                {t('Нет доступных начислений', 'No eligible periods')}
              </option>
            )}
            {candidates.map((p) => (
              <option key={p.id} value={p.id} disabled={lockedIds.has(p.id)}>
                {p.periodStart} · {t('к оплате', 'due')} {p.dueDate}
                {lockedIds.has(p.id)
                  ? ` · ${t('история защищена', 'history protected')}`
                  : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          {t(
            'Новая цена действует с выбранного начисления и далее, в том числе для уже созданных неоплаченных начислений. Платежи и начисления с финансовой историей сохраняются.',
            'The new price starts with the selected period, including existing unpaid future periods. Payments and periods with financial history are preserved.',
          )}
        </p>
        <div className="form-grid">
          <label className="field">
            <span>{t('Новая сумма', 'New amount')}</span>
            <input
              aria-label={t('Новая сумма', 'New amount')}
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setPreview(undefined);
              }}
            />
          </label>
          <label className="field">
            <span>{t('Валюта обязательства', 'Obligation currency')}</span>
            <select
              aria-label={t('Валюта обязательства', 'Obligation currency')}
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setPreview(undefined);
              }}
            >
              {[...new Set([currency, ...availableCurrencies(state)])].map(
                (c) => (
                  <option key={c}>{c}</option>
                ),
              )}
            </select>
          </label>
        </div>
        <label className="field">
          <span>{t('График', 'Schedule')}</span>
          <select
            aria-label={t('График', 'Schedule')}
            value={cadence}
            onChange={(e) => {
              setCadence(e.target.value as BillingRule['cadence']);
              setPreview(undefined);
            }}
          >
            {['weekly', 'monthly', 'quarterly', 'yearly'].map((c) => (
              <option value={c} key={c}>
                {cadenceName(c, t)}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        {preview && (
          <section
            className="notice"
            aria-label={t('Проверка изменения цены', 'Price change preview')}
          >
            <strong>
              {formatMoney(previous.amount ?? 0, previous.currency)} →{' '}
              {formatMoney(preview.rule.amount ?? 0, preview.rule.currency)}
            </strong>
            <p>
              {t('Начиная с', 'Starting')} {preview.rule.effectiveFrom}.
            </p>
            <p>
              {t(
                'Созданных начислений будет обновлено',
                'Existing periods updated',
              )}
              : {preview.changedPeriodIds.length}.{' '}
              {t(
                'Начислений с защищённой историей останется без изменений',
                'Protected historical periods unchanged',
              )}
              : {preview.preservedPeriodIds.length}.
            </p>
            <p>
              {t(
                'Будущие начисления также используют новую цену.',
                'Future periods will also use the new price.',
              )}
            </p>
            {preview.supersededRuleIds.length > 0 && (
              <p>
                {t(
                  'Ранее запланированных тарифов будет заменено',
                  'Previously scheduled rates replaced',
                )}
                : {preview.supersededRuleIds.length}.{' '}
                {t(
                  'Их версии останутся в истории.',
                  'Their versions remain in history.',
                )}
              </p>
            )}
          </section>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            {t('Отмена', 'Cancel')}
          </button>
          <button
            className="button primary"
            disabled={busy || !chosen || lockedIds.has(chosen.id)}
          >
            {preview
              ? t('Подтвердить изменение', 'Confirm price change')
              : t('Проверить изменение', 'Preview change')}
          </button>
        </div>
      </form>
    </>
  );
}

export function PriceHistory({ state, obligation, today, t, close }: Props) {
  const lockedIds = useMemo(() => lockedBillingPeriodIds(state), [state]);
  const rules = state.rules
    .filter((r) => r.obligationId === obligation.id)
    .sort(
      (a, b) =>
        a.effectiveFrom.localeCompare(b.effectiveFrom) ||
        a.id.localeCompare(b.id),
    );
  const current = rules.filter(
    (r) => !r.superseded && (!r.effectiveTo || r.effectiveTo > r.effectiveFrom),
  );
  const currencies = [...new Set(current.map((r) => r.currency))];
  const start = current[0]?.effectiveFrom ?? today;
  const end =
    [
      today,
      obligation.activeTo ?? '',
      ...current.map((r) => r.effectiveFrom),
      ...current.map((r) => r.effectiveTo ?? ''),
    ]
      .sort()
      .at(-1) ?? today;
  const instant = (date: string) => Date.parse(date + 'T00:00:00Z');
  const x = (date: string) =>
    54 +
    ((instant(date) - instant(start)) /
      Math.max(86400000, instant(end) - instant(start))) *
      510;
  const protectedPeriods = state.periods
    .filter((p) => p.obligationId === obligation.id && lockedIds.has(p.id))
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  return (
    <>
      <h2 id="modal-title">{t('История стоимости', 'Price history')}</h2>
      <p className="modal-subtitle">{obligation.title}</p>
      <section
        className="price-history-charts"
        aria-label={t('Графики стоимости', 'Price charts')}
      >
        {protectedPeriods.length > 0 && (
          <p className="notice">
            {t(
              'График показывает тарифы. Начисления с финансовой историей могут сохранять прежнюю цену; они перечислены под историей изменений.',
              'The chart shows rates. Periods with financial history may retain an earlier price; they are listed below the change history.',
            )}
          </p>
        )}
        <p className="muted">
          {t(
            'Цена за один период в валюте обязательства. Разные валюты показаны отдельно, без пересчёта.',
            'Price per billing period in its original currency. Currencies are shown separately without conversion.',
          )}
        </p>
        {currencies.map((currency) => {
          const values = current.filter(
            (r) => r.currency === currency && r.amount !== undefined,
          );
          const maximum = Math.max(1, ...values.map((r) => r.amount!));
          const y = (amount: number) => 145 - (amount / maximum) * 110;
          return (
            <figure key={currency} className="price-history-chart">
              <figcaption>{currency}</figcaption>
              <svg
                viewBox="0 0 600 190"
                role="img"
                aria-label={`${t('График стоимости', 'Price chart')} ${currency}`}
              >
                <line
                  x1="54"
                  x2="564"
                  y1="145"
                  y2="145"
                  stroke="currentColor"
                  opacity=".25"
                />
                <text x="48" y="150" textAnchor="end">
                  0
                </text>
                <text x="54" y="18">
                  {formatMoney(maximum, currency)}
                </text>
                {values.map((rule) => {
                  const next = current.find(
                    (r) => r.effectiveFrom > rule.effectiveFrom,
                  );
                  const until = [
                    rule.effectiveTo ?? end,
                    next?.effectiveFrom ?? end,
                    end,
                  ].sort()[0];
                  return (
                    <g key={rule.id}>
                      <title>
                        {rule.effectiveFrom}:{' '}
                        {formatMoney(rule.amount!, currency)} ·{' '}
                        {cadenceName(rule.cadence, t)}
                      </title>
                      <line
                        x1={x(rule.effectiveFrom)}
                        x2={x(until)}
                        y1={y(rule.amount!)}
                        y2={y(rule.amount!)}
                        stroke="var(--sage, #607b68)"
                        strokeWidth="3"
                      />
                      <circle
                        cx={x(rule.effectiveFrom)}
                        cy={y(rule.amount!)}
                        r="4"
                        fill="var(--sage, #607b68)"
                      />
                    </g>
                  );
                })}
                <text x="54" y="178">
                  {start}
                </text>
                <text x="564" y="178" textAnchor="end">
                  {end}
                </text>
              </svg>
              {!values.length && (
                <p>
                  {t('Сумма пока не определена.', 'Amount is not set yet.')}
                </p>
              )}
            </figure>
          );
        })}
      </section>
      <h3>{t('История изменений', 'Change history')}</h3>
      <div className="price-history-table">
        <table>
          <caption className="sr-only">
            {t('Версии стоимости обязательства', 'Obligation price versions')}
          </caption>
          <thead>
            <tr>
              <th>{t('Начало', 'From')}</th>
              <th>{t('Окончание', 'Until')}</th>
              <th>{t('Стоимость', 'Price')}</th>
              <th>{t('График', 'Schedule')}</th>
            </tr>
          </thead>
          <tbody>
            {[...rules].reverse().map((rule) => (
              <tr key={rule.id}>
                <td>{rule.effectiveFrom}</td>
                <td>
                  {rule.superseded
                    ? t('Заменена', 'Replaced')
                    : (rule.effectiveTo ?? '—')}
                </td>
                <td>
                  {rule.amount === undefined
                    ? '—'
                    : formatMoney(rule.amount, rule.currency)}
                </td>
                <td>{cadenceName(rule.cadence, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {protectedPeriods.length > 0 && (
        <details className="price-history-recorded">
          <summary>
            {t(
              'Начисления с сохранённой финансовой историей',
              'Periods with preserved financial history',
            )}{' '}
            ({protectedPeriods.length})
          </summary>
          <ul>
            {protectedPeriods.map((period) => {
              const rule = state.rules.find(
                (r) => r.id === period.ruleVersionId,
              );
              return (
                <li key={period.id}>
                  {period.periodStart} ·{' '}
                  {period.expectedAmount === undefined
                    ? '—'
                    : formatMoney(
                        period.expectedAmount,
                        rule?.currency ?? state.household.currency,
                      )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={close}>
          {t('Закрыть', 'Close')}
        </button>
      </div>
    </>
  );
}
