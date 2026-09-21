import { useState } from 'react';
import { ChevronDown, Download, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  addMonths,
  DEFAULT_HOUSEHOLD_COLOR,
  exportPeriodCsv,
  formatMoney,
  monthlyFinancialSeries,
  type State,
  type Obligation,
  type Command,
} from '../domain';
import { download } from './store';
import { ObligationIcon } from './ObligationIcons';
import './product-panels.css';

export type Translate = (ru: string, en: string) => string;
export const availableCurrencies = (state: State) => [
  ...new Set([state.household.currency, ...(state.household.currencies ?? [])]),
];
export function beneficiaryLabel(
  state: State,
  obligation: Obligation,
  t: Translate,
) {
  const beneficiaries = obligation.beneficiaries;
  return !beneficiaries || beneficiaries.kind === 'household'
    ? t('Вся семья', 'Whole family')
    : beneficiaries.personIds
        .map(
          (id) =>
            state.people.find((person) => person.id === id)?.displayName ?? id,
        )
        .join(', ');
}

export function beneficiaryPresentation(
  state: State,
  obligation: Obligation,
  t: Translate,
) {
  const beneficiaries = obligation.beneficiaries;
  if (
    beneficiaries?.kind === 'people' &&
    beneficiaries.personIds.length === 1
  ) {
    const person = state.people.find(
      (candidate) => candidate.id === beneficiaries.personIds[0],
    );
    return {
      label: person?.displayName ?? beneficiaries.personIds[0],
      color: person?.color ?? '#3B82F6',
    };
  }
  return {
    label: beneficiaryLabel(state, obligation, t),
    color: state.household.color ?? DEFAULT_HOUSEHOLD_COLOR,
  };
}

export function MonthlyCharts({
  state,
  month,
  t,
}: {
  state: State;
  month: string;
  t: Translate;
}) {
  const [tab, setTab] = useState<'obligations' | 'arrears'>('obligations');
  const from = addMonths(`${month}-01`, -11).slice(0, 7);
  const series = monthlyFinancialSeries(state, from, month);
  const maximum = Math.max(
    1,
    ...series.map((item) =>
      tab === 'obligations' ? item.obligationsTotal : item.arrearsTotal,
    ),
  );
  const beneficiaries = new Map<
    string,
    { key: string; label: string; color: string; total: number }
  >();
  for (const item of series)
    for (const segment of item.byBeneficiary) {
      const label =
        segment.key === 'household'
          ? t('Семья / совместные', 'Household / shared')
          : segment.key === 'mixed'
            ? t('Несколько участников', 'Multiple members')
            : segment.label;
      beneficiaries.set(segment.key, {
        key: segment.key,
        label,
        color: segment.color,
        total: (beneficiaries.get(segment.key)?.total ?? 0) + segment.amount,
      });
    }
  // One order for the entire displayed window; column-reverse places its first entry at the bottom.
  const legend = [...beneficiaries.values()].sort(
    (a, b) => b.total - a.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return (
    <section className="panel monthly-chart">
      <div className="panel-heading">
        <div>
          <h2>{t('По месяцам', 'By month')}</h2>
          <p>
            {from} — {month} · {state.household.currency}
          </p>
        </div>
      </div>
      <div
        className="product-tabs"
        role="tablist"
        aria-label={t('Финансовые графики', 'Financial charts')}
      >
        <button
          role="tab"
          aria-selected={tab === 'obligations'}
          onClick={() => setTab('obligations')}
        >
          {t('Обязательства', 'Obligations')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'arrears'}
          onClick={() => setTab('arrears')}
        >
          {t('Просрочки', 'Arrears')}
        </button>
      </div>
      <div role="tabpanel" className="chart-panel">
        <p className="muted">
          {tab === 'obligations'
            ? t(
                'Сумма начислений. Общие и смешанные расходы показаны серым.',
                'Scheduled charges. Shared costs are shown in grey.',
              )
            : t(
                'Непогашенная просрочка на конец каждого месяца. Дата оплаты учитывается при пересчёте истории.',
                'Unpaid arrears at each month end. Payment dates are used to recalculate history.',
              )}
        </p>
        <div className="chart-scroll">
          <div
            className="monthly-bars"
            aria-label={
              tab === 'obligations'
                ? t('График обязательств', 'Obligations chart')
                : t('График просрочек', 'Arrears chart')
            }
          >
            {series.map((item) => {
              const amounts = new Map(
                item.byBeneficiary.map((segment) => [
                  segment.key,
                  segment.amount,
                ]),
              );
              const amount =
                tab === 'obligations'
                  ? item.obligationsTotal
                  : item.arrearsTotal;
              return (
                <div className="chart-month" key={item.month}>
                  <span className="chart-value">
                    {formatMoney(amount, state.household.currency)}
                  </span>
                  <div className="chart-track">
                    <div
                      className="chart-stack"
                      style={{ height: `${(amount / maximum) * 100}%` }}
                    >
                      {tab === 'obligations' ? (
                        legend.map((segment) => (
                          <div
                            key={segment.key}
                            style={{
                              height: `${amount ? ((amounts.get(segment.key) ?? 0) / amount) * 100 : 0}%`,
                              background: segment.color,
                            }}
                            title={`${segment.label}: ${formatMoney(amounts.get(segment.key) ?? 0, state.household.currency)}`}
                          />
                        ))
                      ) : (
                        <div
                          style={{ height: '100%', background: '#d87361' }}
                          title={formatMoney(amount, state.household.currency)}
                        />
                      )}
                    </div>
                  </div>
                  <span>
                    {new Date(`${item.month}-15T12:00:00`).toLocaleDateString(
                      t('ru-RU', 'en-GB'),
                      { month: 'short' },
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {tab === 'obligations' && (
          <div className="chart-legend">
            {legend.map((item) => (
              <span key={item.key}>
                <i style={{ background: item.color }} />
                {item.label}
              </span>
            ))}
          </div>
        )}
        {series.some((item) => item.unconvertedCount > 0) && (
          <p className="notice">
            {t(
              'Для части начислений не найден курс. Они не включены в суммы графика.',
              'Some charges have no exchange rate and are excluded from chart totals.',
            )}
          </p>
        )}
        <details className="chart-data">
          <summary>{t('Значения графика', 'Chart data')}</summary>
          <table>
            <thead>
              <tr>
                <th>{t('Месяц', 'Month')}</th>
                <th>{t('Обязательства', 'Obligations')}</th>
                <th>{t('Просрочки', 'Arrears')}</th>
              </tr>
            </thead>
            <tbody>
              {series.map((item) => (
                <tr key={item.month}>
                  <td>{item.month}</td>
                  <td>
                    {formatMoney(
                      item.obligationsTotal,
                      state.household.currency,
                    )}
                  </td>
                  <td>
                    {formatMoney(item.arrearsTotal, state.household.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </section>
  );
}

export function FamilyPanel({
  state,
  t,
  canEdit,
  onOpen,
  onEdit,
}: {
  state: State;
  t: Translate;
  canEdit: boolean;
  onOpen: (obligation: Obligation) => void;
  onEdit: (person: State['people'][number]) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  return (
    <>
      <div className="family-expand-actions">
        <button
          className="text-button"
          onClick={() =>
            setExpanded(
              new Set(
                state.people.flatMap((person) => [
                  `${person.id}:benefit`,
                  `${person.id}:responsible`,
                ]),
              ),
            )
          }
        >
          {t('Развернуть всё', 'Expand all')}
        </button>
        <button className="text-button" onClick={() => setExpanded(new Set())}>
          {t('Свернуть всё', 'Collapse all')}
        </button>
      </div>
      <div className="family-grid">
        {state.people.map((person) => {
          const active = state.obligations.filter(
            (o) => o.lifecycleState === 'active',
          );
          const benefits = active.filter(
            (o) =>
              !o.beneficiaries ||
              o.beneficiaries.kind === 'household' ||
              o.beneficiaries.personIds.includes(person.id),
          );
          const responsibilities = active.filter(
            (o) => o.ownerPersonId === person.id,
          );
          return (
            <section className="panel person-card" key={person.id}>
              <span
                className="avatar person-avatar"
                style={{ background: person.color ?? '#597bc1', color: '#fff' }}
              >
                {person.displayName[0]}
              </span>
              <h2>{person.displayName}</h2>
              {canEdit && (
                <button className="text-button" onClick={() => onEdit(person)}>
                  <Pencil size={14} />
                  {t('Имя и цвет', 'Name & colour')}
                </button>
              )}
              {[
                {
                  key: 'benefit',
                  title: t('Пользуется', 'Benefits from'),
                  items: benefits,
                },
                {
                  key: 'responsible',
                  title: t('Отвечает', 'Responsible for'),
                  items: responsibilities,
                },
              ].map((group) => (
                <div className="family-obligation-group" key={group.key}>
                  <button
                    className="family-group-toggle"
                    aria-expanded={expanded.has(`${person.id}:${group.key}`)}
                    onClick={() => toggle(`${person.id}:${group.key}`)}
                  >
                    {group.title}
                    <span>{group.items.length}</span>
                    <ChevronDown size={16} />
                  </button>
                  {expanded.has(`${person.id}:${group.key}`) && (
                    <div className="person-services">
                      {group.items.map((o) => (
                        <button key={o.id} onClick={() => onOpen(o)}>
                          <ObligationIcon
                            iconId={o.iconId}
                            color={o.iconColor}
                          />
                          <span>{o.title}</span>
                        </button>
                      ))}
                      {!group.items.length && (
                        <p className="muted">
                          {t('Нет обязательств', 'No obligations')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}

export function PeriodReports({ state, t }: { state: State; t: Translate }) {
  const [from, setFrom] = useState(
      new Date().toISOString().slice(0, 7) + '-01',
    ),
    [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [obligations, setObligations] = useState(true),
    [payments, setPayments] = useState(true),
    [error, setError] = useState('');
  return (
    <section className="panel settings-section">
      <div className="panel-heading">
        <h2>{t('Экспорт за период', 'Export a period')}</h2>
        <Download size={18} />
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          try {
            if (from > to)
              throw new Error(
                t(
                  'Начало периода позже окончания.',
                  'Start date is after end date.',
                ),
              );
            const report = exportPeriodCsv(state, { from, toInclusive: to });
            if (obligations)
              download(
                `domovoy-obligations-${from}-${to}.csv`,
                report.obligationsCsv,
                'text/csv;charset=utf-8',
              );
            if (payments)
              download(
                `domovoy-payments-${from}-${to}.csv`,
                report.paymentsCsv,
                'text/csv;charset=utf-8',
              );
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>{t('С даты', 'From')}</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>{t('По дату включительно', 'Through date')}</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </label>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={obligations}
            onChange={(e) => setObligations(e.target.checked)}
          />
          {t('Обязательства и начисления', 'Obligations and charges')}
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={payments}
            onChange={(e) => setPayments(e.target.checked)}
          />
          {t('Платежи', 'Payments')}
        </label>
        <p className="muted">
          {t(
            'Каждый выбранный отчёт — отдельный CSV, который открывается в Excel или Google Таблицах.',
            'Each report is a separate CSV for Excel or Google Sheets.',
          )}
        </p>
        {error && (
          <p role="alert" className="notice danger">
            {error}
          </p>
        )}
        <button
          className="button secondary"
          disabled={!obligations && !payments}
        >
          <Download size={16} />
          {t('Скачать отчёты', 'Download reports')}
        </button>
      </form>
    </section>
  );
}

export function AutomaticPaymentsPanel({
  state,
  t,
  canEdit,
  canDelete,
  onAdd,
  onDelete,
}: {
  state: State;
  t: Translate;
  canEdit: boolean;
  canDelete:
    | boolean
    | ((schedule: NonNullable<State['automaticPayments']>[number]) => boolean);
  onAdd: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="panel automatic-payments-panel">
      <div className="panel-heading automatic-payments-heading">
        <div>
          <h2>{t('Автоплатежи', 'Automatic payments')}</h2>
          <p className="muted">
            {t(
              'Автоматические записи об оплате по графику. Приложение не списывает деньги с банковского счёта.',
              'Scheduled payment records. The application does not charge your bank account.',
            )}
          </p>
        </div>
        {canEdit && (
          <button className="button secondary" onClick={onAdd}>
            <Plus size={16} />
            {t('Добавить автоплатёж', 'Add automatic payment')}
          </button>
        )}
      </div>
      {(state.automaticPayments ?? [])
        .filter((schedule) => schedule.enabled)
        .map((schedule) => (
          <div className="simple-row" key={schedule.id}>
            <span className="grow">
              <strong>
                {
                  state.obligations.find((o) => o.id === schedule.obligationId)
                    ?.title
                }
              </strong>
              <small>
                {
                  state.people.find(
                    (person) => person.id === schedule.payerPersonId,
                  )?.displayName
                }{' '}
                · {schedule.startDate}
                {schedule.endDate ? ` — ${schedule.endDate}` : ''} ·{' '}
                {schedule.amount !== undefined
                  ? formatMoney(
                      schedule.amount,
                      schedule.currency ?? state.household.currency,
                    )
                  : t('По сумме начисления', 'Charge amount')}
              </small>
            </span>
            {(typeof canDelete === 'function'
              ? canDelete(schedule)
              : canDelete) && (
              <button
                className="text-button danger-text"
                onClick={() => onDelete(schedule.id)}
              >
                <Trash2 size={16} />
                {t('Удалить', 'Delete')}
              </button>
            )}
          </div>
        ))}
      {!(state.automaticPayments ?? []).some(
        (schedule) => schedule.enabled,
      ) && (
        <div className="empty-state">
          <p>{t('Автоплатежей пока нет', 'No automatic payments yet')}</p>
        </div>
      )}
    </section>
  );
}

export function HouseholdPreferences({
  state,
  t,
  isAdmin,
  busy,
  submit,
}: {
  state: State;
  t: Translate;
  isAdmin: boolean;
  busy: boolean;
  submit: (commands: Command[], label: string) => Promise<void>;
}) {
  const [currency, setCurrency] = useState(state.household.currency),
    [householdColor, setHouseholdColor] = useState(
      state.household.color ?? DEFAULT_HOUSEHOLD_COLOR,
    ),
    [additional, setAdditional] = useState(
      (state.household.currencies ?? [])
        .filter((code) => code !== state.household.currency)
        .join(', '),
    ),
    [acknowledged, setAcknowledged] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void submit(
          [
            {
              type: 'UpdateHousehold',
              payload: {
                name: String(form.get('name')),
                color: householdColor,
                currency,
                currencies: [
                  ...new Set([
                    currency,
                    state.household.currency,
                    ...additional
                      .toUpperCase()
                      .split(/[\s,;]+/)
                      .filter(Boolean),
                  ]),
                ],
                timezone: String(form.get('timezone')),
                locale: state.household.locale,
              },
            },
          ],
          t('Настройки семьи', 'Family settings'),
        );
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>{t('Название', 'Name')}</span>
          <input
            name="name"
            defaultValue={state.household.name}
            required
            disabled={!isAdmin}
          />
        </label>
        <div className="field">
          <span>{t('Цвет всей семьи', 'Whole family colour')}</span>
          <details className="household-colour-picker">
            <summary
              aria-label={t(
                'Выбрать цвет всей семьи',
                'Choose whole family colour',
              )}
              aria-disabled={!isAdmin}
              onClick={(event) => {
                if (!isAdmin) event.preventDefault();
              }}
            >
              <i
                style={{ backgroundColor: householdColor }}
                aria-hidden="true"
              />
              <span>{householdColor.toUpperCase()}</span>
            </summary>
            <div className="household-colour-popover">
              <label>
                <span>{t('Выбрать цвет', 'Choose colour')}</span>
                <input
                  type="color"
                  aria-label={t('Цвет всей семьи', 'Whole family colour')}
                  value={householdColor}
                  onChange={(event) => setHouseholdColor(event.target.value)}
                  disabled={!isAdmin}
                />
              </label>
              <button
                type="button"
                className="button secondary"
                onClick={() => setHouseholdColor(DEFAULT_HOUSEHOLD_COLOR)}
                disabled={!isAdmin}
              >
                {t('По умолчанию', 'Default')}
              </button>
            </div>
          </details>
        </div>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>{t('Основная валюта', 'Base currency')}</span>
          <select
            aria-label={t('Основная валюта', 'Base currency')}
            value={currency}
            onChange={(event) => {
              setCurrency(event.target.value);
              setAcknowledged(false);
            }}
            disabled={!isAdmin}
          >
            {[
              ...new Set([
                state.household.currency,
                ...availableCurrencies(state),
                'CZK',
                'EUR',
                'USD',
                'GBP',
                'UAH',
                'PLN',
                'CHF',
                'CAD',
                'AUD',
                'JPY',
                'KWD',
              ]),
            ].map((code) => (
              <option key={code}>{code}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('Часовой пояс', 'Timezone')}</span>
          <input
            name="timezone"
            defaultValue={state.household.timezone}
            required
            disabled={!isAdmin}
          />
        </label>
      </div>
      <label className="field">
        <span>{t('Дополнительные валюты', 'Additional currencies')}</span>
        <input
          value={additional}
          onChange={(e) => setAdditional(e.target.value)}
          placeholder="USD, EUR, CZK"
          disabled={!isAdmin}
        />
        <small>
          {t(
            'Коды валют через запятую. Они появятся в обязательствах и платежах.',
            'Comma-separated currency codes, available for obligations and payments.',
          )}
        </small>
      </label>
      {currency !== state.household.currency && (
        <div className="notice">
          <p>
            {t(
              'Смена основной валюты пересчитает исторические платежи по курсам на дату оплаты и может привести к погрешностям. Исходные суммы и валюты обязательств сохранятся.',
              'Changing the base currency recalculates historical payments at their payment-date rates and may introduce rounding differences. Original obligation amounts and currencies remain unchanged.',
            )}
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            {t(
              'Понимаю и подтверждаю пересчёт',
              'I understand and confirm recalculation',
            )}
          </label>
        </div>
      )}
      {isAdmin && (
        <button
          className="button primary"
          disabled={
            busy || (currency !== state.household.currency && !acknowledged)
          }
        >
          {t('Сохранить настройки', 'Save settings')}
        </button>
      )}
    </form>
  );
}
