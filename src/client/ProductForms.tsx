import {
  useState,
  cloneElement,
  isValidElement,
  type FormEvent,
  type ReactNode,
  type ReactElement,
} from 'react';
import {
  parseMoney,
  moneyInputValue,
  type State,
  type Command,
  type Obligation,
  type BillingPeriod,
} from '../domain';
import { IconPicker, ObligationIcon } from './ObligationIcons';
import { availableCurrencies, type Translate } from './ProductPanels';
import { obligationCategories } from './categories';

const id = () => crypto.randomUUID();
const field = (label: string, children: ReactNode) => (
  <label className="field">
    <span>{label}</span>
    {isValidElement(children) &&
    ['input', 'select', 'textarea'].includes(String(children.type))
      ? cloneElement(children as ReactElement<{ 'aria-label'?: string }>, {
          'aria-label': label,
        })
      : children}
  </label>
);
type BaseProps = {
  state: State;
  t: Translate;
  today: string;
  busy: boolean;
  submit: (commands: Command[], label: string) => Promise<void>;
  close: () => void;
};
const shifted = (date: string, days: number) => {
  const result = new Date(date + 'T12:00:00Z');
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
};
const periods = (today: string): Command => ({
  type: 'GeneratePeriods',
  payload: { from: today.slice(0, 7) + '-01', to: shifted(today, 400) },
});
function Actions({
  busy,
  close,
  t,
  label,
}: {
  busy: boolean;
  close: () => void;
  t: Translate;
  label?: string;
}) {
  return (
    <div className="modal-actions">
      <button type="button" className="button secondary" onClick={close}>
        {t('Отмена', 'Cancel')}
      </button>
      <button className="button primary" disabled={busy}>
        {label ?? t('Сохранить', 'Save')}
      </button>
    </div>
  );
}

export function ObligationEditor({
  state,
  t,
  today,
  busy,
  submit,
  close,
  obligation,
}: { obligation?: Obligation } & BaseProps) {
  const currentCategory =
    obligation?.category ??
    state.providers.find((provider) => provider.id === obligation?.providerId)
      ?.category ??
    'subscriptions';
  const [icon, setIcon] = useState(obligation?.iconId ?? 'generic:house'),
    [iconColor, setIconColor] = useState(obligation?.iconColor ?? '#607b68'),
    [picker, setPicker] = useState(false),
    [limited, setLimited] = useState(!!obligation?.activeTo),
    [auto, setAuto] = useState(false),
    [all, setAll] = useState(
      !obligation?.beneficiaries ||
        obligation.beneficiaries.kind === 'household',
    ),
    [beneficiaries, setBeneficiaries] = useState<string[]>(
      obligation?.beneficiaries?.kind === 'people'
        ? obligation.beneficiaries.personIds
        : [],
    ),
    [currency, setCurrency] = useState(state.household.currency),
    [owner, setOwner] = useState(obligation?.ownerPersonId ?? ''),
    [error, setError] = useState('');
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      const data = new FormData(event.currentTarget);
      if (!all && !beneficiaries.length)
        throw new Error(
          t(
            'Выберите хотя бы одного получателя пользы.',
            'Choose at least one beneficiary.',
          ),
        );
      const shared = {
        title: String(data.get('title')),
        category: String(data.get('category')),
        ownerPersonId: owner || undefined,
        beneficiaries: all
          ? { kind: 'household' as const }
          : { kind: 'people' as const, personIds: beneficiaries },
        iconId: icon,
        iconColor,
      };
      if (obligation) {
        void submit(
          [
            {
              type: 'UpdateObligation',
              payload: {
                obligationId: obligation.id,
                patch: {
                  ...shared,
                  ownerPersonId: owner || null,
                },
              },
            },
          ],
          t('Изменение обязательства', 'Edit obligation'),
        );
        return;
      }
      const obligationId = id(),
        providerId = id(),
        activeFrom = String(data.get('activeFrom'));
      const activeTo = limited
        ? shifted(String(data.get('activeTo')), 1)
        : undefined;
      if (activeTo && activeTo <= activeFrom)
        throw new Error(
          t(
            'Дата окончания должна быть не раньше начала.',
            'End date must not precede the start date.',
          ),
        );
      const amount = data.get('amount')
        ? parseMoney(String(data.get('amount')), currency)
        : undefined;
      const commands: Command[] = [
        {
          type: 'AddObligation',
          payload: {
            provider: {
              id: providerId,
              name: String(data.get('provider') || data.get('title')),
              category: String(data.get('category')),
            },
            obligation: {
              id: obligationId,
              providerId,
              ...shared,
              activeTo,
              activeFrom,
              lifecycleState: 'active',
              coverageMode: all
                ? 'household'
                : beneficiaries.length > 1
                  ? 'multi_account'
                  : 'single_account',
            },
            rule: {
              id: id(),
              obligationId,
              effectiveFrom: activeFrom,
              cadence: String(data.get('cadence')) as
                'weekly' | 'monthly' | 'quarterly' | 'yearly',
              anchor: activeFrom,
              dueOffsetDays: Number(data.get('dueOffsetDays') || 0),
              amountMode: String(data.get('amountMode')) as
                'fixed' | 'estimate' | 'variable-confirmed',
              amount,
              currency,
              reminderDays: 3,
              graceDays: Number(data.get('graceDays') || 0),
            },
          },
        },
      ];
      if (auto) {
        const payer = String(data.get('autoPayer'));
        if (!payer)
          throw new Error(
            t(
              'Выберите плательщика автоплатежа.',
              'Choose an automatic payment payer.',
            ),
          );
        commands.push({
          type: 'AddAutomaticPayment',
          payload: {
            schedule: {
              id: id(),
              obligationId,
              payerPersonId: payer,
              startDate: activeFrom,
              ...(activeTo ? { endDate: shifted(activeTo, -1) } : {}),
              enabled: true,
            },
          },
        });
      }
      commands.push(periods(today));
      void submit(commands, shared.title);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <h2 id="modal-title">
        {obligation
          ? t('Изменить обязательство', 'Edit obligation')
          : t('Новое обязательство', 'New obligation')}
      </h2>
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      <form className="product-form" onSubmit={onSubmit}>
        <div className="icon-choice">
          <button
            type="button"
            className="obligation-icon-trigger"
            aria-label={t('Выбрать значок', 'Choose icon')}
            title={t('Выбрать значок', 'Choose icon')}
            aria-haspopup="dialog"
            aria-expanded={picker}
            onClick={() => setPicker(true)}
          >
            <ObligationIcon iconId={icon} color={iconColor} size={40} />
          </button>
          {field(
            t('Цвет значка', 'Icon colour'),
            <input
              type="color"
              value={iconColor}
              onChange={(event) => setIconColor(event.target.value)}
            />,
          )}
        </div>
        {field(
          t('Название обязательства', 'Obligation name'),
          <input
            name="title"
            defaultValue={obligation?.title}
            required
            maxLength={120}
            autoFocus
          />,
        )}
        <div className="form-grid">
          {!obligation &&
            field(
              t('Поставщик', 'Provider'),
              <input name="provider" maxLength={120} />,
            )}
          {field(
            t('Категория', 'Category'),
            <select name="category" defaultValue={currentCategory}>
              {!obligationCategories[currentCategory] && (
                <option value={currentCategory}>{currentCategory}</option>
              )}
              {Object.entries(obligationCategories)
                .filter(
                  ([value]) => value !== 'home' || currentCategory === 'home',
                )
                .map(([value, labels]) => (
                  <option key={value} value={value}>
                    {t(...labels)}
                  </option>
                ))}
            </select>,
          )}
        </div>
        {field(
          t('Ответственный — необязательно', 'Responsible person — optional'),
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">{t('Не назначен', 'Unassigned')}</option>
            {state.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>,
        )}
        <fieldset>
          <legend>{t('Кто пользуется', 'Beneficiaries')}</legend>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => setAll(e.target.checked)}
            />
            {t('Вся семья', 'Whole family')}
          </label>
          {!all && (
            <div className="beneficiary-options">
              {state.people.map((person) => (
                <label key={person.id}>
                  <input
                    type="checkbox"
                    checked={beneficiaries.includes(person.id)}
                    onChange={(e) =>
                      setBeneficiaries((previous) =>
                        e.target.checked
                          ? [...previous, person.id]
                          : previous.filter((value) => value !== person.id),
                      )
                    }
                  />
                  {person.displayName}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {!obligation && (
          <>
            <div className="form-grid">
              {field(
                t('Дата первого начисления', 'First charge date'),
                <input
                  type="date"
                  name="activeFrom"
                  defaultValue={today}
                  required
                />,
              )}
              {field(
                t('Повторение', 'Recurrence'),
                <select name="cadence">
                  <option value="monthly">{t('Ежемесячно', 'Monthly')}</option>
                  <option value="weekly">{t('Еженедельно', 'Weekly')}</option>
                  <option value="quarterly">
                    {t('Ежеквартально', 'Quarterly')}
                  </option>
                  <option value="yearly">{t('Ежегодно', 'Yearly')}</option>
                </select>,
              )}
            </div>
            <div className="form-grid">
              {field(
                t('Сумма начисления', 'Charge amount'),
                <input name="amount" inputMode="decimal" placeholder="0.00" />,
              )}
              {field(
                t('Валюта', 'Currency'),
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {availableCurrencies(state).map((code) => (
                    <option key={code}>{code}</option>
                  ))}
                </select>,
              )}
            </div>
            {field(
              t('Тип суммы', 'Amount type'),
              <select name="amountMode">
                <option value="fixed">{t('Фиксированная', 'Fixed')}</option>
                <option value="estimate">
                  {t(
                    'Ожидаемая, требует подтверждения',
                    'Estimated, needs confirmation',
                  )}
                </option>
                <option value="variable-confirmed">
                  {t('Уточняется после счёта', 'Confirmed when billed')}
                </option>
              </select>,
            )}
            <div className="form-grid">
              {field(
                t(
                  'Оплатить через дней после начисления',
                  'Days after charge until due',
                ),
                <input
                  name="dueOffsetDays"
                  type="number"
                  min="0"
                  max="365"
                  defaultValue="0"
                />,
              )}
              {field(
                t('Льготный срок, дней', 'Grace period, days'),
                <input
                  name="graceDays"
                  type="number"
                  min="0"
                  max="60"
                  defaultValue="0"
                />,
              )}
            </div>
          </>
        )}
        {!obligation && (
          <>
            <label className="checkbox-row form-checkbox">
              <input
                type="checkbox"
                checked={limited}
                onChange={(e) => setLimited(e.target.checked)}
              />
              {t('Ограничить срок обязательства', 'Set an end date')}
            </label>
            {limited &&
              field(
                t('Последний день действия', 'Last active day'),
                <input
                  type="date"
                  name="activeTo"
                  defaultValue={today}
                  required
                />,
              )}
            {limited && (
              <p className="muted">
                {t(
                  'После этой даты новые начисления не создаются. Неоплаченные начисления останутся в просрочке.',
                  'New charges stop after this date. Existing unpaid charges remain outstanding.',
                )}
              </p>
            )}
          </>
        )}
        {obligation && (
          <p className="muted">
            {t(
              'Даты и график меняются в отдельном окне «Даты и график» с проверкой существующих начислений и платежей.',
              'Use Dates and schedule to change dates after reviewing existing charges and payments.',
            )}
          </p>
        )}
        {!obligation && (
          <>
            <label className="checkbox-row form-checkbox">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
              />
              {t('Создать автоплатёж', 'Create an automatic payment')}
            </label>
            {auto && (
              <>
                {field(
                  t('Кто оплачивает автоматически', 'Automatic payment payer'),
                  <select
                    name="autoPayer"
                    key={owner}
                    defaultValue={owner}
                    required
                  >
                    <option value="">
                      {t('Выберите человека', 'Select a person')}
                    </option>
                    {state.people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.displayName}
                      </option>
                    ))}
                  </select>,
                )}
                <p className="payment-currency-note">
                  {t(
                    'Оплаты будут записываться по сумме подтверждённых начислений. Банковские списания приложение не выполняет.',
                    'Payments are recorded for confirmed charge amounts. The application does not make bank transfers.',
                  )}
                </p>
              </>
            )}
          </>
        )}
        <Actions
          busy={busy}
          close={close}
          t={t}
          label={
            obligation
              ? undefined
              : t('Создать обязательство', 'Create obligation')
          }
        />
      </form>
      {picker && (
        <IconPicker
          value={icon}
          onSelect={(value) => {
            setIcon(value);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
          t={t}
        />
      )}
    </>
  );
}

export function PersonEditor({
  t,
  busy,
  submit,
  close,
  person,
}: { person?: State['people'][number] } & BaseProps) {
  const [colour, setColour] = useState(person?.color ?? '#597bc1');
  return (
    <>
      <h2 id="modal-title">
        {person
          ? t('Изменить человека', 'Edit person')
          : t('Новый член семьи', 'New family member')}
      </h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget),
            displayName = String(values.get('name'));
          void submit(
            [
              person
                ? {
                    type: 'UpdatePerson',
                    payload: {
                      personId: person.id,
                      patch: { displayName, color: colour },
                    },
                  }
                : {
                    type: 'AddPerson',
                    payload: { id: id(), displayName, color: colour },
                  },
            ],
            t('Член семьи', 'Family member'),
          );
        }}
      >
        {field(
          t('Имя', 'Name'),
          <input
            name="name"
            defaultValue={person?.displayName}
            required
            maxLength={100}
            autoFocus
          />,
        )}
        {field(
          t('Цвет на графиках', 'Chart colour'),
          <span className="inline-colour">
            <input
              type="color"
              value={colour}
              onChange={(e) => setColour(e.target.value)}
            />
            <span>{colour}</span>
          </span>,
        )}
        <Actions busy={busy} close={close} t={t} />
      </form>
    </>
  );
}

export function PaymentEditor({
  state,
  t,
  today,
  busy,
  submit,
  close,
  period,
}: { period?: BillingPeriod } & BaseProps) {
  const [selected, setSelected] = useState(period?.obligationId ?? ''),
    [currency, setCurrency] = useState(state.household.currency),
    [amount, setAmount] = useState(''),
    [payer, setPayer] = useState(''),
    [paidAt, setPaidAt] = useState(today),
    [error, setError] = useState('');
  const choose = (obligationId: string) => {
    setSelected(obligationId);
    const obligation = state.obligations.find((o) => o.id === obligationId),
      rule =
        [...state.rules]
          .filter(
            (r) =>
              r.obligationId === obligationId &&
              !r.superseded &&
              r.effectiveFrom <= paidAt,
          )
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ??
        state.rules.find(
          (r) => r.obligationId === obligationId && !r.superseded,
        );
    setCurrency(rule?.currency ?? state.household.currency);
    setAmount(
      rule?.amount !== undefined
        ? moneyInputValue(rule.amount, rule.currency)
        : '',
    );
    setPayer(obligation?.ownerPersonId ?? '');
  };
  const [initialized, setInitialized] = useState(false);
  if (!initialized) {
    setInitialized(true);
    if (period?.obligationId) choose(period.obligationId);
  }
  return (
    <>
      <h2 id="modal-title">{t('Записать платёж', 'Record a payment')}</h2>
      <p className="modal-subtitle">
        {t(
          'Запись уже совершённой оплаты. Остаток автоматически покроет следующие начисления этого обязательства.',
          'Record an actual payment. Unused credit automatically covers later charges for this obligation.',
        )}
      </p>
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      <form
        className="product-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          try {
            const data = new FormData(event.currentTarget);
            if (!selected)
              throw new Error(
                t('Выберите обязательство.', 'Choose an obligation.'),
              );
            void submit(
              [
                periods(today),
                {
                  type: 'RecordPaymentAndAllocate',
                  payload: {
                    payment: {
                      id: id(),
                      obligationId: selected,
                      paidAt,
                      amount: parseMoney(amount, currency),
                      currency,
                      payerPersonId: payer,
                      source: 'manual',
                      descriptor: String(
                        data.get('descriptor') ||
                          state.obligations.find((o) => o.id === selected)
                            ?.title ||
                          '',
                      ),
                    },
                    allocations: [],
                  },
                },
              ],
              t('Новый платёж', 'New payment'),
            );
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {field(
          t('Обязательство', 'Obligation'),
          <select
            value={selected}
            onChange={(e) => choose(e.target.value)}
            required
            autoFocus
          >
            <option value="">
              {t(
                'Сначала выберите обязательство',
                'Choose an obligation first',
              )}
            </option>
            {state.obligations.map((o) => (
              <option value={o.id} key={o.id}>
                {o.title}
              </option>
            ))}
          </select>,
        )}
        <div className="form-grid">
          {field(
            t('Сумма платежа', 'Payment amount'),
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              inputMode="decimal"
              disabled={!selected}
            />,
          )}
          {field(
            t('Валюта платежа', 'Payment currency'),
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled={!selected}
            >
              {[...new Set([...availableCurrencies(state), currency])].map(
                (code) => (
                  <option key={code}>{code}</option>
                ),
              )}
            </select>,
          )}
        </div>
        {field(
          t('Дата оплаты', 'Payment date'),
          <input
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            max={today}
            required
          />,
        )}
        {field(
          t('Кто оплатил', 'Payer'),
          <select
            value={payer}
            onChange={(e) => setPayer(e.target.value)}
            required
          >
            <option value="">
              {t('Выберите человека', 'Select a person')}
            </option>
            {state.people.map((person) => (
              <option value={person.id} key={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>,
        )}
        {currency !== state.household.currency && (
          <p className="payment-currency-note">
            {t('Сумма в основной валюте', 'Base-currency amount')}:{' '}
            {state.household.currency}.{' '}
            {t(
              'Сервер сохранит исходную сумму и рассчитает эквивалент по курсу на дату оплаты. Если курса нет, платёж не будет записан.',
              'The server keeps the original amount and converts it at the payment-date rate. A missing rate prevents the payment from being recorded.',
            )}
          </p>
        )}
        {field(
          t('Описание — необязательно', 'Description — optional'),
          <input name="descriptor" maxLength={300} />,
        )}
        <Actions
          busy={busy || !selected}
          close={close}
          t={t}
          label={t('Записать платёж', 'Record payment')}
        />
      </form>
    </>
  );
}

export function AutomaticPaymentEditor({
  state,
  t,
  today,
  busy,
  submit,
  close,
}: BaseProps) {
  const [selected, setSelected] = useState(''),
    [payer, setPayer] = useState(''),
    [fixed, setFixed] = useState(false),
    [currency, setCurrency] = useState(state.household.currency),
    [error, setError] = useState('');
  return (
    <>
      <h2 id="modal-title">{t('Новый автоплатёж', 'New automatic payment')}</h2>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      <form
        className="product-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          try {
            const form = new FormData(event.currentTarget);
            void submit(
              [
                {
                  type: 'AddAutomaticPayment',
                  payload: {
                    schedule: {
                      id: id(),
                      obligationId: selected,
                      payerPersonId: payer,
                      startDate: String(form.get('startDate')),
                      enabled: true,
                      ...(fixed
                        ? {
                            amount: parseMoney(
                              String(form.get('amount')),
                              currency,
                            ),
                            currency,
                          }
                        : {}),
                      ...(form.get('endDate')
                        ? { endDate: String(form.get('endDate')) }
                        : {}),
                    },
                  },
                },
              ],
              t('Новый автоплатёж', 'New automatic payment'),
            );
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {field(
          t('Обязательство', 'Obligation'),
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setPayer(
                state.obligations.find((o) => o.id === e.target.value)
                  ?.ownerPersonId ?? '',
              );
              const rule = state.rules.find(
                (r) => r.obligationId === e.target.value && !r.superseded,
              );
              setCurrency(rule?.currency ?? state.household.currency);
            }}
            required
          >
            <option value="">
              {t('Выберите обязательство', 'Choose an obligation')}
            </option>
            {state.obligations
              .filter((o) => o.lifecycleState === 'active')
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
          </select>,
        )}
        {field(
          t('Кто оплачивает', 'Payer'),
          <select
            value={payer}
            onChange={(e) => setPayer(e.target.value)}
            required
          >
            <option value="">
              {t('Выберите человека', 'Select a person')}
            </option>
            {state.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>,
        )}
        <div className="form-grid">
          {field(
            t('Начиная с даты', 'Starting on'),
            <input
              name="startDate"
              type="date"
              defaultValue={today}
              required
            />,
          )}
          {field(
            t('До даты — необязательно', 'Until — optional'),
            <input name="endDate" type="date" />,
          )}
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={fixed}
            onChange={(e) => setFixed(e.target.checked)}
          />
          {t(
            'Своя сумма вместо суммы начисления',
            'Custom amount instead of charge amount',
          )}
        </label>
        {fixed && (
          <div className="form-grid">
            {field(
              t('Сумма', 'Amount'),
              <input name="amount" inputMode="decimal" required />,
            )}
            {field(
              t('Валюта', 'Currency'),
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {[...new Set([...availableCurrencies(state), currency])].map(
                  (code) => (
                    <option key={code}>{code}</option>
                  ),
                )}
              </select>,
            )}
          </div>
        )}
        <p className="payment-currency-note">
          {t(
            'Автоматическое ведение записей, без списания денег с банковского счёта.',
            'Automatic bookkeeping; no money is charged to a bank account.',
          )}
        </p>
        <Actions busy={busy} close={close} t={t} />
      </form>
    </>
  );
}
