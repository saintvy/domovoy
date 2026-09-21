import { useState, type FormEvent } from 'react';
import {
  addDays,
  formatMoney,
  previewObligationSchedule,
  previewObligationDeletion,
  type State,
  type Obligation,
  type Command,
} from '../domain';
import type { Translate } from './ProductPanels';
import './obligation-lifecycle.css';
type Props = {
  state: State;
  obligation: Obligation;
  today: string;
  t: Translate;
  busy: boolean;
  submit: (commands: Command[], label: string) => Promise<void>;
  close: () => void;
};
type SchedulePayload = Extract<
  Command,
  { type: 'UpdateObligationSchedule' }
>['payload'];
type Policy = NonNullable<SchedulePayload['outOfRangePaymentPolicy']>;
type Preview = ReturnType<typeof previewObligationSchedule>;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const blockedText = (reason: string, t: Translate) =>
  ({
    SCHEDULE_PRICE_BOUNDARY: t(
      'Новый календарь не совпадает с датами изменений цены. Сначала согласуйте границы версий цены с новым графиком.',
      'The new calendar conflicts with existing price change dates. Align the price version boundaries with the new schedule first.',
    ),
    NO_DATES_INSIDE_RANGE: t(
      'В отменённом сроке нет даты для переноса. Выберите удаление платежей или сохранение аванса.',
      'There is no date inside the cancelled interval. Delete the payments or keep advance credit.',
    ),
    SHARED_PAYMENT_CONFLICT: t(
      'Платёж также относится к другому обязательству. Его нельзя удалить или перенести; сохраните средства авансом.',
      'A payment also belongs to another obligation. It cannot be deleted or moved; keep the funds as credit.',
    ),
    MOVE_AFTER_REFUND_DATE: t(
      'Новая дата платежа оказалась бы позже его возврата. Выберите другой срок или сохраните аванс.',
      'The new payment date would be later than its refund. Choose another interval or keep credit.',
    ),
    FUTURE_PAYMENT_DATE: t(
      'Платёж нельзя переносить на будущую дату. Выберите другой срок или сохраните аванс.',
      'A payment cannot be moved into the future. Choose another interval or keep credit.',
    ),
  })[reason] ?? reason;
const cadenceLabels = (t: Translate) => [
  ['weekly', t('Еженедельно', 'Weekly')],
  ['monthly', t('Ежемесячно', 'Monthly')],
  ['quarterly', t('Ежеквартально', 'Quarterly')],
  ['yearly', t('Ежегодно', 'Yearly')],
];

export function ObligationScheduleEditor({
  state,
  obligation,
  today,
  t,
  busy,
  submit,
  close,
  archive = false,
}: Props & { archive?: boolean }) {
  const rule = state.rules
    .filter((r) => r.obligationId === obligation.id && !r.superseded)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const originalDue = addDays(rule.anchor, rule.dueOffsetDays);
  const [start, setStart] = useState(obligation.activeFrom),
    [end, setEnd] = useState(
      obligation.activeTo ? addDays(obligation.activeTo, -1) : today,
    ),
    [limited, setLimited] = useState(archive || !!obligation.activeTo),
    [firstDue, setFirstDue] = useState(originalDue),
    [cadence, setCadence] = useState(rule.cadence),
    [policy, setPolicy] = useState<Policy | ''>(''),
    [preview, setPreview] = useState<Preview>(),
    [error, setError] = useState(''),
    [accepted, setAccepted] = useState(false);
  const payload = (): SchedulePayload => ({
    obligationId: obligation.id,
    activeFrom: start,
    activeTo: limited ? addDays(end, 1) : null,
    anchor: firstDue === originalDue ? rule.anchor : firstDue,
    cadence,
    dueOffsetDays: firstDue === originalDue ? rule.dueOffsetDays : 0,
    ...(archive ? { archive: true } : {}),
    ...(policy ? { outOfRangePaymentPolicy: policy } : {}),
  });
  function reset() {
    setPreview(undefined);
    setAccepted(false);
    setError('');
    setPolicy('');
  }
  function choosePolicy(value: Policy) {
    setPolicy(value);
    setAccepted(false);
    setError('');
    try {
      setPreview(
        previewObligationSchedule(state, {
          ...payload(),
          outOfRangePaymentPolicy: value,
        }),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const commandPayload = payload();
      const next = previewObligationSchedule(state, commandPayload);
      setPreview(next);
      if (!preview || !accepted) return;
      if (
        next.blockedReasons.length ||
        (next.outOfRangePaymentIds.length && !policy)
      )
        return;
      await submit(
        [{ type: 'UpdateObligationSchedule', payload: commandPayload }],
        archive
          ? t('Архивация обязательства', 'Archive obligation')
          : t('Изменение дат и графика', 'Change dates and schedule'),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <>
      <h2 id="modal-title">
        {archive
          ? t('Архивировать обязательство', 'Archive obligation')
          : t('Даты и график', 'Dates and schedule')}
      </h2>
      <p className="modal-subtitle">{obligation.title}</p>
      <form onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span>{t('Начало обязательства', 'Obligation start')}</span>
            <input
              aria-label={t('Начало обязательства', 'Obligation start')}
              type="date"
              value={start}
              required
              onChange={(e) => {
                if (firstDue === start) setFirstDue(e.target.value);
                setStart(e.target.value);
                reset();
              }}
            />
          </label>
          <label className="field">
            <span>
              {t(
                'Первая дата оплаты по графику',
                'First scheduled payment date',
              )}
            </span>
            <input
              aria-label={t(
                'Первая дата оплаты по графику',
                'First scheduled payment date',
              )}
              type="date"
              value={firstDue}
              required
              onChange={(e) => {
                setFirstDue(e.target.value);
                reset();
              }}
            />
          </label>
        </div>
        <p className="muted">
          {t(
            'Первая дата задаёт день следующих платежей: например, 1 сентября — затем первое число каждого месяца. Начало обязательства определяет, с какого дня учитывать начисления.',
            'The first date sets the recurring payment day: for example, September 1 means the first day of each month. The start date determines when charges begin.',
          )}
        </p>
        <label className="field">
          <span>{t('График', 'Schedule')}</span>
          <select
            aria-label={t('График', 'Schedule')}
            value={cadence}
            onChange={(e) => {
              setCadence(e.target.value as typeof cadence);
              reset();
            }}
          >
            {cadenceLabels(t).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {!archive && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={limited}
              onChange={(e) => {
                setLimited(e.target.checked);
                reset();
              }}
            />
            {t('Указать последний день действия', 'Set last active day')}
          </label>
        )}
        {limited && (
          <label className="field">
            <span>{t('Последний день действия', 'Last active day')}</span>
            <input
              aria-label={t('Последний день действия', 'Last active day')}
              type="date"
              value={end}
              required
              onChange={(e) => {
                setEnd(e.target.value);
                reset();
              }}
            />
          </label>
        )}
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        {preview && (
          <section
            aria-label={t(
              'Предварительный просмотр изменений',
              'Change preview',
            )}
            className="notice"
          >
            <h3>{t('Что изменится', 'What will change')}</h3>
            {preview.cancelledBeforeStart && (
              <p>
                {t(
                  'Обязательство будет отменено до начала: начислений в этом сроке не останется. Для полного удаления используйте отдельное действие администратора.',
                  'The obligation will be cancelled before it starts, leaving no charges in this interval. An administrator can use the separate permanent deletion action.',
                )}
              </p>
            )}
            <p>
              {t('Начислений будет создано', 'Charges created')}:{' '}
              {preview.createdPeriodIds.length}; {t('изменено', 'changed')}:{' '}
              {preview.changedPeriodIds.length}; {t('удалено', 'removed')}:{' '}
              {preview.removedPeriodIds.length};{' '}
              {t('оставлено без изменений', 'unchanged')}:{' '}
              {preview.preservedPeriodIds.length}.
            </p>
            {preview.outOfRangePaymentIds.length > 0 && (
              <fieldset className="lifecycle-policy">
                <legend>
                  {t(
                    'Платежи за пределами новых дат',
                    'Payments outside the new dates',
                  )}{' '}
                  ({preview.outOfRangePaymentIds.length})
                </legend>
                <p>
                  {t(
                    'Выберите, что сделать с этими платежами. Без выбора изменения не сохраняются.',
                    'Choose how to handle these payments before saving.',
                  )}
                </p>
                <ul>
                  {preview.outOfRangePaymentIds.map((id) => {
                    const payment = state.payments.find(
                      (item) => item.id === id,
                    )!;
                    return (
                      <li key={id}>
                        {payment.paidAt} ·{' '}
                        {formatMoney(payment.amount, payment.currency)}
                      </li>
                    );
                  })}
                </ul>
                {(
                  [
                    [
                      'delete',
                      t('Удалить эти платежи', 'Delete these payments'),
                      t(
                        'Удалить платежи и их связанные записи из истории.',
                        'Remove the payments and their related history.',
                      ),
                    ],
                    [
                      'move_inside',
                      t(
                        'Сдвинуть даты внутрь срока',
                        'Move dates inside the active period',
                      ),
                      t(
                        'Перенести дату к ближайшему краю нового срока.',
                        'Move the date to the nearest boundary of the new active period.',
                      ),
                    ],
                    [
                      'keep_credit',
                      t('Оставить авансом', 'Keep as advance credit'),
                      t(
                        'Сохранить фактические даты. Освобождённые суммы оплатят новые начисления; остаток останется авансом.',
                        'Keep actual dates. Released amounts cover new charges; any remainder stays as credit.',
                      ),
                    ],
                  ] as const
                ).map(([value, label, description]) => (
                  <label className="lifecycle-policy-choice" key={value}>
                    <input
                      type="radio"
                      name="outOfRangePaymentPolicy"
                      value={value}
                      checked={policy === value}
                      onChange={() => choosePolicy(value)}
                    />
                    <span>
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {preview.paymentDateChanges.length > 0 && (
              <ul>
                {preview.paymentDateChanges.map((change) => (
                  <li key={change.paymentId}>
                    {change.from} → {change.to}
                  </li>
                ))}
              </ul>
            )}
            {preview.deletedPaymentIds.length > 0 && (
              <p>
                {t('Платежей будет удалено', 'Payments deleted')}:{' '}
                {preview.deletedPaymentIds.length}.
              </p>
            )}
            {preview.preservedCreditPaymentIds.length > 0 && (
              <p>
                {t('Платежей останется авансом', 'Payments kept as credit')}:{' '}
                {preview.preservedCreditPaymentIds.length}.
              </p>
            )}
            {preview.blockedReasons.map((reason, index) => (
              <p role="alert" className="danger-text" key={index}>
                {blockedText(reason, t)}
              </p>
            ))}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              {t(
                'Я проверил изменения начислений и платежей',
                'I reviewed the changes to charges and payments',
              )}
            </label>
          </section>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            {t('Отмена', 'Cancel')}
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              Boolean(
                preview &&
                (!accepted ||
                  preview.blockedReasons.length ||
                  (preview.outOfRangePaymentIds.length && !policy)),
              )
            }
          >
            {preview
              ? t('Подтвердить изменения', 'Confirm changes')
              : t('Проверить изменения', 'Preview changes')}
          </button>
        </div>
      </form>
    </>
  );
}

export function ObligationDeleteDialog({
  state,
  obligation,
  t,
  busy,
  submit,
  close,
}: Props) {
  const preview = previewObligationDeletion(state, obligation.id),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState('');
  return (
    <>
      <h2 id="modal-title">
        {t('Удалить обязательство целиком', 'Delete entire obligation')}
      </h2>
      <p className="modal-subtitle">{obligation.title}</p>
      <p className="notice danger">
        {t(
          'Обязательство, его начисления, платежи, возвраты и автоплатежи будут удалены. Это действие нельзя отменить в интерфейсе.',
          'The obligation, its charges, payments, refunds and automatic schedules will be deleted. This action cannot be undone in the interface.',
        )}
      </p>
      <ul>
        <li>
          {t('Начислений', 'Charges')}: {preview.periodIds.length}
        </li>
        <li>
          {t('Платежей', 'Payments')}: {preview.paymentIds.length}
        </li>
        <li>
          {t('Возвратов', 'Refunds')}: {preview.refundIds.length}
        </li>
        <li>
          {t('Автоплатежей', 'Automatic schedules')}:{' '}
          {preview.automaticPaymentIds.length}
        </li>
      </ul>
      {preview.totalsByCurrency.map((total) => (
        <p key={total.currency}>{formatMoney(total.amount, total.currency)}</p>
      ))}
      {preview.blockedReasons.map((reason, index) => (
        <p className="notice danger" role="alert" key={index}>
          {blockedText(reason, t)}
        </p>
      ))}
      {error && (
        <p role="alert" className="notice danger">
          {error}
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            confirmation !== obligation.title ||
            preview.blockedReasons.length
          )
            return;
          try {
            await submit(
              [
                {
                  type: 'DeleteObligation',
                  payload: { obligationId: obligation.id },
                },
              ],
              t('Полное удаление обязательства', 'Delete entire obligation'),
            );
          } catch (error) {
            setError(errorText(error));
          }
        }}
      >
        <label className="field">
          <span>
            {t(
              'Для подтверждения введите название',
              'Type the name to confirm',
            )}
          </span>
          <input
            aria-label={t(
              'Для подтверждения введите название',
              'Type the name to confirm',
            )}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            {t('Отмена', 'Cancel')}
          </button>
          <button
            className="button danger"
            disabled={
              busy ||
              confirmation !== obligation.title ||
              preview.blockedReasons.length > 0
            }
          >
            {t('Удалить безвозвратно', 'Delete permanently')}
          </button>
        </div>
      </form>
    </>
  );
}
