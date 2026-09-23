import { ObligationIcon } from './ObligationIcons';
import './family-account.css';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { householdToday, type DailyReportTime, type State } from '../domain';
import { availableFamilyObligations } from './family-availability';
import { api, db, type User } from './store';
import { clearInvitation, pendingInvitation } from './auth';

type Translator = (ru: string, en: string) => string;
type Change = () => Promise<void>;
const errors: Record<string, string> = {
  ALREADY_IN_FAMILY:
    'Этот Google-аккаунт уже состоит в семье. Сначала выйдите из неё в настройках.',
  INVITATION_INVALID:
    'Приглашение недействительно или предназначено для другого Google-аккаунта.',
  INVITATION_EXPIRED:
    'Приглашение истекло или отменено. Попросите главу семьи отправить новое.',
  INVITATION_EMAIL_NOT_CONFIGURED: 'Отправка приглашений пока не настроена.',
  PERSON_ALREADY_LINKED: 'Этот человек уже связан с Google-аккаунтом.',
  FRESH_GOOGLE_LOGIN_REQUIRED:
    'Войдите через Google заново: глава семьи завершил прежние сессии.',
};
const message = (error: unknown) =>
  errors[(error as { code?: string }).code ?? ''] ??
  (error instanceof Error ? error.message : String(error));
async function clearFamilyCache() {
  await db.transaction('rw', db.values, db.drafts, async () => {
    await db.values.clear();
    await db.drafts.clear();
  });
  localStorage.removeItem('domovoy-instance');
}

export function FamilyOnboarding({
  onComplete,
  onError,
  t,
}: {
  onComplete: Change;
  onError: (error: unknown) => void;
  t: Translator;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [invite, setInvite] = useState(pendingInvitation());
  async function perform(body: unknown, path: string) {
    setBusy(true);
    setError('');
    try {
      await clearFamilyCache();
      await api(path, body);
      if (path.includes('accept')) clearInvitation();
      await onComplete();
    } catch (e) {
      setError(message(e));
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-form">
      <h2>{t('Ваша семья', 'Your household')}</h2>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      {invite ? (
        <>
          <p>
            {t(
              'Примите приглашение с тем Google-аккаунтом, на который оно пришло.',
              'Accept with the Google account that received the invitation.',
            )}
          </p>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void perform({ token: invite }, '/invitations/accept')
            }
          >
            {t('Принять приглашение', 'Accept invitation')}
          </button>
          <button
            className="button ghost"
            disabled={busy}
            onClick={() => {
              clearInvitation();
              setInvite(null);
            }}
          >
            {t('Отложить приглашение', 'Dismiss invitation')}
          </button>
        </>
      ) : (
        <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void perform(
              {
                name: data.get('name'),
                currency: data.get('currency'),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                locale: 'ru',
              },
              '/families',
            );
          }}
        >
          <p>
            {t(
              'Создайте семью и станьте её главой. Если вас уже пригласили, откройте ссылку из письма.',
              'Create a household and become its head. If you were invited, open the email link.',
            )}
          </p>
          <label className="field">
            <span>{t('Название семьи', 'Household name')}</span>
            <input
              name="name"
              required
              maxLength={100}
              autoComplete="off"
              placeholder={t('Наша семья', 'Our household')}
            />
          </label>
          <label className="field">
            <span>{t('Основная валюта', 'Base currency')}</span>
            <select name="currency" defaultValue="EUR">
              {[
                'EUR',
                'USD',
                'CZK',
                'UAH',
                'GBP',
                'PLN',
                'RUB',
                'CHF',
                'JPY',
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <button className="button primary" disabled={busy}>
            {t('Создать семью', 'Create household')}
          </button>
        </form>
      )}
    </section>
  );
}

interface Member extends User {
  email: string;
  personId: string;
  telegram?: { linked: boolean; username?: string };
  telegramReportTime?: DailyReportTime | null;
  nextReportAt?: string | null;
}
interface Invitation {
  id: string;
  email: string;
  personId: string;
  role: string;
  expiresAt: number;
}
interface Access {
  members: Member[];
  invitations: Invitation[];
  invitationsEnabled: boolean;
}
function TelegramMemberSettings({
  member,
  familyTime,
  canSchedule,
  isSelf,
  busy,
  setBusy,
  reload,
  reportError,
  t,
}: {
  member: Member;
  familyTime: DailyReportTime;
  canSchedule: boolean;
  isSelf: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  reload: () => Promise<void>;
  reportError: (value: string) => void;
  t: Translator;
}) {
  const effective = member.telegramReportTime ?? familyTime;
  const [inherit, setInherit] = useState(member.telegramReportTime == null),
    [hour, setHour] = useState(effective.hour),
    [timeZone, setTimeZone] = useState(effective.timeZone),
    [link, setLink] = useState<{ url: string; expiresAt: number }>();
  useEffect(() => {
    const next = member.telegramReportTime ?? familyTime;
    setInherit(member.telegramReportTime == null);
    setHour(next.hour);
    setTimeZone(next.timeZone);
  }, [member.telegramReportTime, familyTime.hour, familyTime.timeZone]);

  async function request(path: string, body?: unknown, method?: string) {
    setBusy(true);
    reportError('');
    try {
      const result = await api<{ url?: string; expiresAt?: number }>(
        path,
        body,
        method,
      );
      if (result.url && result.expiresAt)
        setLink({ url: result.url, expiresAt: result.expiresAt });
      if (method === 'DELETE') setLink(undefined);
      await reload();
    } catch (error) {
      reportError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="family-telegram-settings">
      <div className="family-telegram-heading">
        <strong>Telegram</strong>
        <span className={member.telegram?.linked ? 'badge-soft' : 'muted'}>
          {member.telegram?.linked
            ? member.telegram.username
              ? `@${member.telegram.username.replace(/^@/, '')}`
              : t('Привязан', 'Linked')
            : t('Не привязан', 'Not linked')}
        </span>
      </div>
      {isSelf && (
        <div className="family-telegram-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void request('/telegram/link', {})}
          >
            {member.telegram?.linked
              ? t('Перепривязать Telegram', 'Relink Telegram')
              : t('Привязать Telegram', 'Link Telegram')}
          </button>
          {member.telegram?.linked && (
            <button
              type="button"
              className="text-button danger-text"
              disabled={busy}
              onClick={() =>
                void request('/telegram/link', undefined, 'DELETE')
              }
            >
              {t('Отвязать', 'Unlink')}
            </button>
          )}
        </div>
      )}
      {isSelf && link && (
        <p className="family-telegram-link">
          <a
            className="button primary"
            href={link.url}
            target="_blank"
            rel="noreferrer"
          >
            {t('Открыть Telegram', 'Open Telegram')}
          </a>
          <small>
            {t('Ссылка действует до', 'Link expires at')}:{' '}
            {new Date(link.expiresAt).toLocaleString(t('ru-RU', 'en-GB'))}
          </small>
        </p>
      )}
      {canSchedule && (
        <div className="family-telegram-schedule">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={inherit}
              disabled={busy}
              onChange={(event) => {
                setInherit(event.target.checked);
                if (!event.target.checked) {
                  setHour(familyTime.hour);
                  setTimeZone(
                    Intl.DateTimeFormat().resolvedOptions().timeZone ||
                      familyTime.timeZone,
                  );
                }
              }}
            />
            {t('Использовать время семьи', 'Use household report time')}
          </label>
          {!inherit && (
            <div className="form-grid">
              <label className="field">
                <span>{t('Местный час', 'Local hour')}</span>
                <select
                  value={hour}
                  disabled={busy}
                  onChange={(event) => setHour(Number(event.target.value))}
                >
                  {Array.from({ length: 24 }, (_, value) => (
                    <option value={value} key={value}>
                      {String(value).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('Часовой пояс', 'Timezone')}</span>
                <input
                  value={timeZone}
                  disabled={busy}
                  onChange={(event) => setTimeZone(event.target.value)}
                />
              </label>
            </div>
          )}
          <small className="muted">
            {t(
              'Местный час сохраняется при переходе на летнее время. Для часовых поясов со смещением на неполный час отчёт придёт при первом часовом запуске после выбранного времени.',
              'The local hour is preserved across daylight-saving changes. For partial-hour timezones, delivery occurs on the first hourly run after the selected time.',
            )}
          </small>
          <button
            type="button"
            className="button secondary"
            disabled={busy || (!inherit && !timeZone.trim())}
            onClick={() =>
              void request(
                `/family/members/${encodeURIComponent(member.id)}/reminders`,
                {
                  telegramReportTime: inherit
                    ? null
                    : { hour, timeZone: timeZone.trim() },
                },
                'PATCH',
              )
            }
          >
            {t('Сохранить время отчёта', 'Save report time')}
          </button>
          {member.nextReportAt && (
            <small>
              {t('Следующий отчёт', 'Next report')}:{' '}
              {new Date(member.nextReportAt).toLocaleString(
                t('ru-RU', 'en-GB'),
                { timeZone: effective.timeZone },
              )}{' '}
              ({effective.timeZone})
            </small>
          )}
        </div>
      )}
    </div>
  );
}
const memberRoles = ['observer', 'editor', 'own_editor', 'deleter'] as const;
const roleLabel = (role: string, t: Translator) =>
  ({
    admin: t('Администратор', 'Administrator'),
    observer: t('Только просмотр', 'Read only'),
    editor: t('Создание записей', 'Create records'),
    own_editor: t('Изменение своих записей', 'Manage own records'),
    deleter: t('Изменение всех записей', 'Manage all records'),
  })[role] ?? role;
function RoleOptions({
  t,
  allowAdmin = false,
}: {
  t: Translator;
  allowAdmin?: boolean;
}) {
  return (
    <>
      <option value="admin" disabled={!allowAdmin}>
        {roleLabel('admin', t)}
      </option>
      {memberRoles.map((role) => (
        <option key={role} value={role}>
          {roleLabel(role, t)}
        </option>
      ))}
    </>
  );
}
export function FamilyAccessPanel({
  state,
  user,
  onChange,
  onSavePerson,
  onOpen,
  saving = false,
  operationError = '',
  today = householdToday(state),
  t,
}: {
  state: State;
  user: User;
  onChange: Change;
  onSavePerson: (
    personId: string,
    patch: { displayName: string; color: string },
  ) => Promise<void>;
  saving?: boolean;
  operationError?: string;
  onOpen: (obligation: State['obligations'][number]) => void;
  today?: string;
  t: Translator;
}) {
  const [access, setAccess] = useState<Access>(),
    [error, setError] = useState(''),
    [working, setBusy] = useState(false);
  const busy = working || saving;
  const [displayName, setDisplayName] = useState(''),
    [color, setColor] = useState('#597bc1');
  const [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [draftRoles, setDraftRoles] = useState<Record<string, string>>({});
  const [emailPerson, setEmailPerson] = useState<string | null>(null),
    [email, setEmail] = useState('');
  const popup = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const directory = useRef<HTMLDivElement>(null),
    [cardWidth, setCardWidth] = useState<number>();
  // Measure only each header's natural width. Expanded service names must not resize
  // every card. Inert temporary clones never receive focus or enter the a11y tree.
  useLayoutEffect(() => {
    const list = directory.current;
    if (!list) return;
    let cancelled = false,
      frame = 0;
    const measure = () => {
      if (cancelled) return;
      let widest = 0;
      for (const header of list.querySelectorAll<HTMLElement>(
        '.family-person-row',
      )) {
        const clone = header.cloneNode(true) as HTMLElement;
        clone.classList.add('family-header-probe');
        clone.inert = true;
        clone.setAttribute('aria-hidden', 'true');
        document.body.append(clone);
        const width = clone.getBoundingClientRect().width;
        clone.remove();
        const card = header.parentElement!,
          style = getComputedStyle(card);
        widest = Math.max(
          widest,
          width +
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.borderRightWidth),
        );
      }
      if (widest)
        setCardWidth((current) =>
          current === Math.ceil(widest) ? current : Math.ceil(widest),
        );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    for (const header of list.querySelectorAll('.family-person-row'))
      observer.observe(header);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [state.people, access, draftRoles, t]);
  const admin = user.role === 'admin';
  const reload = async () => setAccess(await api<Access>('/family/members'));
  useEffect(() => {
    let active = true;
    const update = () => {
      if (document.visibilityState === 'hidden') return;
      void api<Access>('/family/members')
        .then((value) => {
          if (active) setAccess(value);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    };
    update();
    const timer = window.setInterval(update, 60000);
    window.addEventListener('focus', update);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, [state.household.id, state.revision, user.role]);
  useEffect(() => {
    if (!emailPerson) return;
    popup.current?.querySelector<HTMLInputElement>('input')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        setEmailPerson(null);
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(
          popup.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ) ?? [],
        );
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      trigger.current?.focus();
    };
  }, [emailPerson, busy]);
  async function perform(
    path: string,
    body?: unknown,
    method?: string,
  ): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      await api(path, body, method);
      await reload();
      await onChange();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const people = state.people
    .filter((person) => !person.archivedAt)
    .sort((a, b) => {
      const aAdmin =
        access?.members.find((member) => member.personId === a.id)?.role ===
        'admin';
      const bAdmin =
        access?.members.find((member) => member.personId === b.id)?.role ===
        'admin';
      return Number(bAdmin) - Number(aAdmin);
    });
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  function openEmail(personId: string, address: string) {
    trigger.current = document.activeElement as HTMLElement;
    setError('');
    setEmail(address);
    const person = state.people.find((p) => p.id === personId);
    setDisplayName(person?.displayName ?? '');
    setColor(person?.color ?? '#597bc1');
    setEmailPerson(personId);
  }
  async function changeRole(
    personId: string,
    member: Member | undefined,
    invitation: Invitation | undefined,
    role: string,
  ) {
    if (role === 'admin') {
      if (!member || member.role === 'admin' || !admin) return;
      if (
        confirm(
          t(
            'Передать этому участнику права администратора? Вы перестанете быть администратором.',
            'Transfer administrator permissions to this member? You will no longer be the administrator.',
          ),
        )
      ) {
        if (await perform('/family/transfer', { subject: member.id }))
          setEmailPerson(null);
      }
    } else if (member)
      await perform(
        '/family/members/' + encodeURIComponent(member.id),
        { role },
        'PATCH',
      );
    else if (invitation)
      await perform('/family/invitations/' + invitation.id, { role }, 'PATCH');
    else setDraftRoles((current) => ({ ...current, [personId]: role }));
  }
  const selectedPerson = people.find((person) => person.id === emailPerson);
  const selectedMember = access?.members.find(
    (member) => member.personId === emailPerson,
  );
  const selectedInvitation = access?.invitations.find(
    (invitation) => invitation.personId === emailPerson,
  );
  const active = availableFamilyObligations(state, today);
  const responsibilities = availableFamilyObligations(
    state,
    today,
    'responsible',
  );
  return (
    <section
      className="family-directory"
      aria-label={t('Участники семьи', 'Household members')}
    >
      {error && !emailPerson && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      <div className="family-expand-actions">
        <button
          className="text-button"
          onClick={() =>
            setExpanded(
              new Set(
                people.flatMap((person) => [
                  person.id + ':benefit',
                  person.id + ':responsible',
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
      {!access && (
        <p role="status" className="muted">
          {t('Загрузка участников…', 'Loading members…')}
        </p>
      )}
      <div
        className="family-directory-list"
        ref={directory}
        style={
          cardWidth
            ? ({ '--family-card-width': `${cardWidth}px` } as CSSProperties)
            : undefined
        }
      >
        {people.map((person) => {
          const member = access?.members.find(
              (value) => value.personId === person.id,
            ),
            invitation = access?.invitations.find(
              (value) => value.personId === person.id,
            );
          const role =
            member?.role ??
            invitation?.role ??
            draftRoles[person.id] ??
            'observer';
          const address = member?.email ?? invitation?.email;
          const groups = [
            {
              key: 'benefit',
              label: t('Пользуется', 'Benefits from'),
              items: active.filter(
                (obligation) =>
                  !obligation.beneficiaries ||
                  obligation.beneficiaries.kind === 'household' ||
                  obligation.beneficiaries.personIds.includes(person.id),
              ),
            },
            {
              key: 'responsible',
              label: t('Отвечает', 'Responsible for'),
              items: responsibilities.filter(
                (obligation) => obligation.ownerPersonId === person.id,
              ),
            },
          ];
          const personName = (
            <>
              <span
                className="family-person-dot"
                style={{ background: person.color ?? '#597bc1' }}
                aria-hidden="true"
              />
              <strong>{person.displayName}</strong>
            </>
          );
          return (
            <article className="panel family-directory-person" key={person.id}>
              <header className="family-person-row">
                {admin ? (
                  <button
                    className="family-person-name"
                    onClick={() => openEmail(person.id, address ?? '')}
                    aria-label={
                      t('Изменить имя и цвет: ', 'Edit name and colour: ') +
                      person.displayName
                    }
                  >
                    {personName}
                  </button>
                ) : (
                  <div className="family-person-name">{personName}</div>
                )}
                <div className="family-person-access">
                  <div
                    className={
                      'family-person-email' +
                      (invitation && !member ? ' is-pending' : '')
                    }
                  >
                    {admin ? (
                      <button
                        className="text-button"
                        disabled={busy || !access}
                        onClick={() => openEmail(person.id, address ?? '')}
                      >
                        {address ?? t('Добавить email', 'Add email')}
                      </button>
                    ) : (
                      <span>{address ?? t('Без аккаунта', 'No account')}</span>
                    )}
                    {invitation && !member && (
                      <small>
                        {t('Email не подтверждён', 'Email not confirmed')}
                      </small>
                    )}
                  </div>
                  {admin ? (
                    <select
                      aria-label={t('Роль: ', 'Role: ') + person.displayName}
                      value={role}
                      disabled={busy || !access || member?.role === 'admin'}
                      onChange={(event) =>
                        void changeRole(
                          person.id,
                          member,
                          invitation,
                          event.target.value,
                        )
                      }
                    >
                      <RoleOptions t={t} allowAdmin={Boolean(member)} />
                    </select>
                  ) : (
                    <span className="family-role-label">
                      {member || invitation
                        ? roleLabel(role, t)
                        : t('Без доступа', 'No access')}
                    </span>
                  )}
                </div>
              </header>
              {member && (admin || member.id === user.id) && (
                <TelegramMemberSettings
                  member={member}
                  familyTime={
                    state.household.telegramReportTime ?? {
                      hour: 9,
                      timeZone: state.household.timezone,
                    }
                  }
                  canSchedule={admin || member.id === user.id}
                  isSelf={member.id === user.id}
                  busy={busy}
                  setBusy={setBusy}
                  reload={reload}
                  reportError={setError}
                  t={t}
                />
              )}
              <div className="family-person-obligations">
                {groups.map((group) => {
                  const key = person.id + ':' + group.key;
                  return (
                    <div className="family-obligation-group" key={group.key}>
                      <button
                        className="family-group-toggle"
                        aria-expanded={expanded.has(key)}
                        onClick={() => toggle(key)}
                      >
                        {group.label}
                        <span>{group.items.length}</span>
                        <ChevronDown size={16} aria-hidden="true" />
                      </button>
                      {expanded.has(key) && (
                        <div className="person-services">
                          {group.items.map((obligation) => (
                            <button
                              key={obligation.id}
                              onClick={() => onOpen(obligation)}
                            >
                              <ObligationIcon
                                iconId={obligation.iconId}
                                color={obligation.iconColor}
                              />
                              <span>{obligation.title}</span>
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
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
      {selectedPerson && (
        <div
          className="family-email-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy)
              setEmailPerson(null);
          }}
        >
          <div
            className="panel family-email-dialog"
            ref={popup}
            role="dialog"
            aria-modal="true"
            aria-labelledby="family-email-title"
          >
            <div className="family-email-heading">
              <h2 id="family-email-title">
                {t('Участник семьи', 'Household member')}
              </h2>
              <button
                className="button ghost"
                aria-label={t('Закрыть', 'Close')}
                disabled={busy}
                onClick={() => setEmailPerson(null)}
              >
                ×
              </button>
            </div>
            {(error || operationError) && (
              <p className="notice danger" role="alert">
                {error || operationError}
              </p>
            )}
            <form
              className="family-person-edit"
              onSubmit={(event) => {
                event.preventDefault();
                void onSavePerson(selectedPerson.id, {
                  displayName: displayName.trim(),
                  color,
                });
              }}
            >
              <label className="field">
                <span>{t('Имя', 'Name')}</span>
                <input
                  required
                  maxLength={100}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('Цвет', 'Colour')}</span>
                <input
                  type="color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                />
              </label>
              <button
                className="button secondary"
                disabled={busy || !displayName.trim()}
              >
                {t('Сохранить имя и цвет', 'Save name and colour')}
              </button>
            </form>
            <label className="field">
              <span>{t('Права доступа', 'Permissions')}</span>
              <select
                value={
                  selectedMember?.role ??
                  selectedInvitation?.role ??
                  draftRoles[selectedPerson.id] ??
                  'observer'
                }
                disabled={busy || selectedMember?.role === 'admin'}
                onChange={(event) =>
                  void changeRole(
                    selectedPerson.id,
                    selectedMember,
                    selectedInvitation,
                    event.target.value,
                  )
                }
              >
                <RoleOptions t={t} allowAdmin={Boolean(selectedMember)} />
              </select>
            </label>
            {selectedMember ? (
              <>
                <label className="field">
                  <span>
                    {t('Подтверждённый Google email', 'Verified Google email')}
                  </span>
                  <input type="email" value={selectedMember.email} readOnly />
                </label>
                <p className="muted">
                  {t(
                    'Адрес подтверждён входом через Google. Для другого аккаунта сначала отключите текущий доступ; финансовая история останется.',
                    'The address is verified through Google. To link a different account, remove current access first; financial history remains.',
                  )}
                </p>
                {selectedMember.role !== 'admin' && (
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          t(
                            'Отключить этот Google-аккаунт от семьи?',
                            'Remove this Google account from the household?',
                          ),
                        )
                      )
                        void perform(
                          '/family/members/' +
                            encodeURIComponent(selectedMember.id),
                          undefined,
                          'DELETE',
                        ).then((ok) => {
                          if (ok) setEmailPerson(null);
                        });
                    }}
                  >
                    {t('Отключить аккаунт', 'Remove account')}
                  </button>
                )}
              </>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform('/family/invitations', {
                    personId: selectedPerson.id,
                    email,
                    role:
                      selectedInvitation?.role ??
                      draftRoles[selectedPerson.id] ??
                      'observer',
                  }).then((ok) => {
                    if (ok) setEmailPerson(null);
                  });
                }}
              >
                <label className="field">
                  <span>Email</span>
                  <input
                    type="email"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                  />
                </label>
                <p className="muted">
                  {t(
                    'До принятия приглашения этот адрес не получает доступ к семье. Ссылка действует 7 дней.',
                    'This address has no household access until the invitation is accepted. The link expires in 7 days.',
                  )}
                </p>
                {!access?.invitationsEnabled && (
                  <p className="notice">
                    {t(
                      'Отправка приглашений в этом окружении пока не настроена.',
                      'Invitation delivery is not configured in this environment.',
                    )}
                  </p>
                )}
                <button
                  className="button primary"
                  disabled={busy || !access?.invitationsEnabled}
                >
                  {t('Отправить приглашение', 'Send invitation')}
                </button>
                {selectedInvitation && (
                  <button
                    type="button"
                    className="button ghost"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        '/family/invitations/' + selectedInvitation.id,
                        undefined,
                        'DELETE',
                      ).then((ok) => {
                        if (ok) setEmailPerson(null);
                      })
                    }
                  >
                    {t('Отменить приглашение', 'Cancel invitation')}
                  </button>
                )}
              </form>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function FamilyAccountSettings({
  user,
  onChange,
  t,
}: {
  user: User;
  state: State;
  onChange: Change;
  t: Translator;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function leave() {
    setBusy(true);
    setError('');
    try {
      await api('/family/leave', { confirm: true });
      await clearFamilyCache();
      await onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>{t('Участие в семье', 'Household membership')}</h3>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      {pendingInvitation() && (
        <p className="notice">
          {t(
            'Чтобы принять открытое приглашение в другую семью, сначала выйдите из текущей.',
            'Leave the current household before accepting the open invitation to another household.',
          )}
        </p>
      )}
      <p>
        {user.role === 'admin'
          ? t(
              'При выходе управление перейдёт случайному участнику с Google-аккаунтом. Если таких участников нет, семья и её данные будут удалены.',
              'When you leave, a random member with a Google account becomes administrator. If none remain, the household and its data will be deleted.',
            )
          : t(
              'Вы сможете создать другую семью или принять приглашение. Ваша история в этой семье сохранится.',
              'You can create another household or accept an invitation. Your history in this household will remain.',
            )}
      </p>
      <button
        className="button danger"
        disabled={busy}
        onClick={() => {
          if (
            confirm(
              t(
                'Выйти из семьи? Это действие завершит ваши сессии в ней.',
                'Leave the household? This ends your household sessions.',
              ),
            )
          )
            void leave();
        }}
      >
        {t('Выйти из семьи', 'Leave household')}
      </button>
    </section>
  );
}
