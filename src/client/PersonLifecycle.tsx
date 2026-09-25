import { useEffect, useRef, useState } from 'react';
import {
  previewPersonLifecycle,
  getPeriodStatus,
  formatMoney,
  type Command,
  type State,
} from '../domain';
import type { Translate } from './ProductPanels';

export function PersonLifecycleDialog({
  state,
  personId,
  today,
  busy,
  error,
  submit,
  close,
  t,
}: {
  state: State;
  personId: string;
  today: string;
  busy: boolean;
  error: string;
  submit: (commands: Command[], label: string) => Promise<void>;
  close: () => void;
  t: Translate;
}) {
  const person = state.people.find((value) => value.id === personId);
  const initiallyArchived = useRef(Boolean(person?.archivedAt));
  const [mode, setMode] = useState<'archive' | 'delete' | 'restore'>(
    person?.archivedAt ? 'restore' : 'archive',
  );
  const [policy, setPolicy] = useState<'keep_nobody' | 'end_at_last_accrual'>(
    'keep_nobody',
  );
  const [restore, setRestore] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!person || Boolean(person.archivedAt) !== initiallyArchived.current)
      closeRef.current();
  }, [person]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  if (!person) return null;
  const preview = previewPersonLifecycle(state, personId, today);
  const name = (id: string) =>
    state.obligations.find((o) => o.id === id)?.title ?? id;
  return (
    <div
      className="family-email-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) close();
      }}
    >
      <div
        className="panel family-email-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-lifecycle-title"
        ref={dialog}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            close();
          }
          if (event.key === 'Tab') {
            const nodes = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled)',
              ) ?? [],
            );
            if (!nodes.length) {
              event.preventDefault();
              return;
            }
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              last.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id="person-lifecycle-title">
          {t('Управление участником', 'Manage member')}: {person.displayName}
        </h2>
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const command: Command =
              mode === 'delete'
                ? { type: 'DeletePerson', payload: { personId } }
                : mode === 'restore'
                  ? {
                      type: 'RestorePerson',
                      payload: {
                        personId,
                        restoreBeneficiaries: restore,
                        expectedDate: today,
                      },
                    }
                  : {
                      type: 'ArchivePerson',
                      payload: {
                        personId,
                        soleBeneficiaryPolicy: policy,
                        expectedDate: today,
                      },
                    };
            void submit(
              [command],
              t('Изменение участника семьи', 'Household member lifecycle'),
            );
          }}
        >
          <label className="field">
            <span>{t('Действие', 'Action')}</span>
            <select
              aria-label={t('Действие', 'Action')}
              value={mode}
              disabled={busy}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              {person.archivedAt ? (
                <option value="restore">
                  {t('Вернуть из архива', 'Restore from archive')}
                </option>
              ) : (
                <option value="archive">
                  {t('Поместить в архив', 'Archive member')}
                </option>
              )}
              <option value="delete">
                {t('Удалить полностью', 'Delete permanently')}
              </option>
            </select>
          </label>
          {mode === 'delete' && (
            <p className="notice danger">
              {t(
                'Участник будет удалён без возможности восстановления. Во всех записях, включая историю, его заменит «Никто». Суммы, платежи и журнал действий сохранятся. Начисления продолжатся. Доступ аккаунта и приглашения будут отозваны.',
                'This member will be permanently deleted. Nobody will replace them in all records, including history. Amounts, payments and the activity log remain. Charges continue. Account access and invitations will be revoked.',
              )}
            </p>
          )}
          {mode === 'archive' && (
            <>
              <p>
                {t(
                  'Имя и цвет останутся у начислений со сроком оплаты по сегодняшний день. Начисления с будущим сроком оплаты, включая оплаченные заранее, и плательщик автоплатежей перейдут к «Никто». История платежей сохранится. Доступ аккаунта и приглашения будут отозваны.',
                  'Their name and colour remain on charges due through today. Charges due later, including prepaid charges, and automatic payment payer references change to Nobody. Payment history remains. Account access and invitations will be revoked.',
                )}
              </p>
              {preview.soleBeneficiaryObligationIds.length > 0 && (
                <>
                  <label className="field">
                    <span>
                      {t(
                        'Обязательства, где участник — единственный бенефициар',
                        'Obligations where this member is the sole beneficiary',
                      )}
                    </span>
                    <select
                      value={policy}
                      disabled={busy}
                      onChange={(event) =>
                        setPolicy(event.target.value as typeof policy)
                      }
                    >
                      <option value="keep_nobody">
                        {t(
                          'Оставить начисления для «Никто»',
                          'Continue charges for Nobody',
                        )}
                      </option>
                      <option value="end_at_last_accrual">
                        {t(
                          'Остановить после последнего начисления',
                          'Stop after the last accrued charge',
                        )}
                      </option>
                    </select>
                  </label>
                  <ul>
                    {preview.soleBeneficiaryObligationIds.map((id) => (
                      <li key={id}>{name(id)}</li>
                    ))}
                  </ul>
                  {policy === 'end_at_last_accrual' && (
                    <>
                      <p>
                        {t(
                          'Новые начисления и автоплатежи прекратятся. Уже записанные платежи и долг сохранятся. Это не отменяет договор с поставщиком.',
                          'New charges and automatic payment entries stop. Recorded payments and debt remain. This does not cancel your provider contract.',
                        )}
                      </p>
                      <ul>
                        {preview.stoppedObligations.map((item) => (
                          <li key={item.obligationId}>
                            {name(item.obligationId)}:{' '}
                            {t(
                              'конец периода (не включительно)',
                              'exclusive end date',
                            )}{' '}
                            {item.activeTo}.
                            {item.preservedFuturePeriodIds.length > 0 && (
                              <div>
                                <strong>
                                  {' '}
                                  {t(
                                    'Сохранятся будущие счета с финансовой историей',
                                    'Future charges with financial history retained',
                                  )}
                                  : {item.preservedFuturePeriodIds.length}.
                                </strong>
                                <ul>
                                  {item.preservedFuturePeriodIds.map((id) => {
                                    const period = state.periods.find(
                                      (value) => value.id === id,
                                    )!;
                                    const rule = state.rules.find(
                                      (value) =>
                                        value.id === period.ruleVersionId,
                                    );
                                    const status = getPeriodStatus(
                                      state,
                                      period,
                                      today,
                                    ).settlementState;
                                    const label =
                                      status === 'paid'
                                        ? t('оплачен', 'paid')
                                        : status === 'partial'
                                          ? t('частично оплачен', 'partly paid')
                                          : status === 'waived'
                                            ? t('списан', 'waived')
                                            : status === 'undetermined'
                                              ? t(
                                                  'сумма не подтверждена',
                                                  'amount unconfirmed',
                                                )
                                              : t('не оплачен', 'unpaid');
                                    return (
                                      <li key={id}>
                                        {period.dueDate} ·{' '}
                                        {period.expectedAmount === undefined
                                          ? t(
                                              'сумма неизвестна',
                                              'amount unknown',
                                            )
                                          : formatMoney(
                                              period.expectedAmount,
                                              rule?.currency ??
                                                state.household.currency,
                                            )}{' '}
                                        · {label}
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            )}
                            {item.automaticPaymentIds.length > 0 && (
                              <p>
                                {t(
                                  'Будут отключены автоплатежи',
                                  'Automatic schedules to disable',
                                )}
                                :{' '}
                                {item.automaticPaymentIds
                                  .map((id) => {
                                    const schedule =
                                      state.automaticPayments?.find(
                                        (value) => value.id === id,
                                      )!;
                                    return `${schedule.startDate}${schedule.endDate ? ' — ' + schedule.endDate : ''} (${schedule.payerPersonId === personId ? person.displayName : (state.people.find((value) => value.id === schedule.payerPersonId)?.displayName ?? t('Никто', 'Nobody'))})`;
                                  })
                                  .join('; ')}
                                .
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </>
          )}
          {mode === 'restore' && (
            <>
              <p>
                {t(
                  'Участник вернётся в семью без доступа аккаунта. Для входа отправьте новое приглашение. Ответственность, плательщики автоплатежей и остановленные обязательства автоматически не восстанавливаются.',
                  'The member returns without account access. Send a new invitation to grant access. Responsibility, automatic payers and stopped obligations are not restored automatically.',
                )}
              </p>
              {preview.restorableObligationIds.length > 0 ? (
                <>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={restore}
                      disabled={busy}
                      onChange={(event) => setRestore(event.target.checked)}
                    />
                    {t(
                      'Вернуть бенефициара вместо «Никто»',
                      'Restore beneficiary assignments from Nobody',
                    )}
                  </label>
                  <ul>
                    {preview.restorableObligationIds.map((id) => (
                      <li key={id}>{name(id)}</li>
                    ))}
                  </ul>
                  <p className="muted">
                    {t(
                      'Только сохранившиеся связи. Ручные изменения не перезаписываются; прошлые начисления останутся без изменений.',
                      'Only retained links are eligible. Manual changes are not overwritten; past charges remain unchanged.',
                    )}
                  </p>
                </>
              ) : (
                <p className="muted">
                  {t(
                    'Связей с «Никто», доступных для восстановления, нет.',
                    'No Nobody assignments are eligible for restoration.',
                  )}
                </p>
              )}
            </>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={close}
            >
              {t('Отмена', 'Cancel')}
            </button>
            <button
              className={`button ${mode === 'delete' ? 'danger' : 'primary'}`}
              disabled={busy}
            >
              {mode === 'delete'
                ? t('Удалить полностью', 'Delete permanently')
                : mode === 'restore'
                  ? t('Вернуть из архива', 'Restore from archive')
                  : t('Поместить в архив', 'Archive member')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
