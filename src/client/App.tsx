import {
  FamilyOnboarding,
  FamilyAccessPanel,
  FamilyAccountSettings,
} from './FamilyAccount';
import { ObligationIcon } from './ObligationIcons';
import { PriceChangeEditor, PriceHistory } from './PriceManagement';
import { categoryLabel } from './categories';
import { AppearanceSettings } from './AppearanceSettings';
import { readLanguage, saveLanguage } from './language';
import {
  groupMonthlyObligations,
  type MonthlyObligationRow,
} from './monthly-obligations';
import {
  ObligationScheduleEditor,
  ObligationDeleteDialog,
} from './ObligationLifecycle';
import {
  MonthlyCharts,
  PeriodReports,
  AutomaticPaymentsPanel,
  HouseholdPreferences,
  beneficiaryLabel,
  beneficiaryPresentation,
} from './ProductPanels';
import {
  ObligationEditor,
  PersonEditor,
  PaymentEditor,
  AutomaticPaymentEditor,
} from './ProductForms';
import { periodBaseAmount, paymentBaseAmount } from '../domain';
import { GoogleLogin } from './GoogleLogin';
import {
  authError as initialAuthError,
  authEpoch,
  clearAuth,
  revokeRefreshToken,
  startGoogleLogin,
  isAuthenticated,
} from './auth';

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Cloud,
  CreditCard,
  Download,
  ExternalLink,
  FileClock,
  FileUp,
  Home,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
  WifiOff,
  X,
} from 'lucide-react';
import {
  addMonths,
  generatePeriods,
  getPeriodStatus,
  parseMoney,
  formatMoney,
  moneyInputValue,
  previewCsv,
  type State,
  type Command,
  type BillingPeriod,
  type Obligation,
  type Payment,
} from '../domain';
import {
  api,
  ApiError,
  db,
  download,
  editorInstanceId,
  type User,
  type Lease,
  type Draft,
} from './store';
type Page =
  | 'overview'
  | 'obligations'
  | 'payments'
  | 'family'
  | 'import'
  | 'history'
  | 'settings';
type Modal = {
  type: string;
  data?: any;
} | null;

const icons = {
  overview: LayoutDashboard,
  obligations: ListChecks,
  payments: Wallet,
  family: Users,
  import: FileUp,
  history: FileClock,
  settings: Settings,
};
const titles: Record<Page, [string, string]> = {
  overview: ['Обзор', 'Overview'],
  obligations: ['Обязательства', 'Obligations'],
  payments: ['Платежи', 'Payments'],
  family: ['Семья и доступы', 'Family & access'],
  import: ['Импорт/Экспорт', 'Import/Export'],
  history: ['История', 'History'],
  settings: ['Настройки', 'Settings'],
};
const todayISO = (
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const id = () => crypto.randomUUID();
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Brand({ lang }: { lang: 'ru' | 'en' }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Home size={25} strokeWidth={2.1} />
      </span>
      <span>
        {lang === 'ru' ? 'домовой' : 'Domovoy'}
        <span className="brand-dot">.</span>
      </span>
    </div>
  );
}
function ServiceIcon({
  title,
  iconId,
  iconColor,
  small = false,
}: {
  title: string;
  iconId?: string;
  iconColor?: string;
  small?: boolean;
}) {
  return (
    <span className={`service-icon generic ${small ? 'small' : ''}`}>
      <ObligationIcon
        iconId={iconId}
        color={iconColor}
        size={small ? 20 : 26}
        label={title}
      />
    </span>
  );
}
function HouseArt() {
  return (
    <div className="house-art" aria-hidden="true">
      <span className="art-star one">✦</span>
      <span className="art-star two">✧</span>
      <div className="art-orbit" />
      <div className="art-home">
        <div className="art-roof" />
        <div className="art-house-body">
          <span className="art-window" />
          <span className="art-door" />
          <span className="art-step" />
        </div>
      </div>
      <div className="art-plant">
        <i />
        <i />
        <i />
        <b />
      </div>
      <div className="art-check">
        <Check size={23} />
      </div>
      <span className="art-cloud" />
    </div>
  );
}
export default function App() {
  const [lang, setLang] = useState(readLanguage);
  const [languageUse, setLanguageUse] = useState(0);
  const t = (ru: string, en: string) => (lang === 'ru' ? ru : en);
  const [paymentTab, setPaymentTab] = useState<'payments' | 'automatic'>(
    'payments',
  );
  const [state, setState] = useState<State | null>(null),
    [user, setUser] = useState<User | null>(null),
    [session, setSession] = useState<any>(null),
    [generation, setGeneration] = useState(''),
    [lease, setLease] = useState<Lease | null>(null);
  const [page, setPage] = useState<Page>('overview'),
    [month, setMonth] = useState(todayISO().slice(0, 7)),
    [today, setToday] = useState(todayISO()),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [modal, setModal] = useState<Modal>(null),
    [toast, setToast] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [mobileMenu, setMobileMenu] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [drafts, setDrafts] = useState<Draft[]>([]),
    [loading, setLoading] = useState(true),
    [authError, setAuthError] = useState(initialAuthError());
  const [sessions, setSessions] = useState<any[]>([]),
    [csv, setCsv] = useState(''),
    [csvPayer, setCsvPayer] = useState(''),
    [csvPreview, setCsvPreview] = useState<any>(null);
  const inFlight = useRef(false);
  const recoveryInFlight = useRef(false);
  const languageWrites = useRef(Promise.resolve());
  const languageWriteVersion = useRef(0);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    const active = () => {
      setLang(readLanguage());
      setLanguageUse((value) => value + 1);
    };
    window.addEventListener('focus', active);
    return () => window.removeEventListener('focus', active);
  }, []);
  useEffect(() => {
    const version = ++languageWriteVersion.current;
    const epoch = authEpoch();
    if (
      loading ||
      !online ||
      !isAuthenticated() ||
      (!user && !session?.onboarding)
    )
      return;
    languageWrites.current = languageWrites.current
      .catch(() => {})
      .then(async () => {
        if (version !== languageWriteVersion.current || epoch !== authEpoch())
          return;
        try {
          await api('/account/preferences', { locale: lang }, 'PATCH');
        } catch {
          if (version === languageWriteVersion.current && epoch === authEpoch())
            setToast(
              lang === 'ru'
                ? 'Язык сохранён на устройстве. Язык сообщений обновится после восстановления связи.'
                : 'Language saved on this device. Message language will update when the connection returns.',
            );
        }
      });
  }, [lang, languageUse, loading, online, user?.id, session?.onboarding]);

  const languageButton = (welcome = false) => (
    <button
      className={`icon-button${welcome ? ' welcome-language' : ''}`}
      aria-label={t('Сменить язык', 'Change language')}
      title={t('English', 'Русский')}
      onClick={() => {
        const next = lang === 'ru' ? 'en' : 'ru';
        saveLanguage(next);
        setLang(next);
      }}
    >
      {lang.toUpperCase()}
    </button>
  );

  const actor = user?.id || '';
  const canEdit = ['admin', 'editor', 'own_editor', 'deleter'].includes(
    user?.role || '',
  );
  const isAdmin = user?.role === 'admin';
  const canDelete = ['admin', 'deleter'].includes(user?.role || '');
  const canManageEntity = (entity?: { createdByUserId?: string }) =>
    canDelete ||
    (user?.role === 'own_editor' &&
      Boolean(entity?.createdByUserId) &&
      entity?.createdByUserId === user.id);
  const canManageModal = () => {
    if (!modal) return false;
    if (
      ['obligation', 'payment', 'automaticPayment', 'drafts'].includes(
        modal.type,
      )
    )
      return canEdit;
    if (modal.type === 'person') return isAdmin;
    const record = modal.data?.obligation ?? modal.data;
    if (['paymentDetail', 'refund'].includes(modal.type))
      return canManageEntity(
        state?.payments.find((payment) => payment.id === record?.id),
      );
    return canManageEntity(
      state?.obligations.find(
        (obligation) =>
          obligation.id === record?.id ||
          obligation.id === record?.obligationId,
      ),
    );
  };
  const money = (n: number) =>
    formatMoney(n, state?.household.currency || 'EUR', lang);
  const date = (value: string) =>
    new Date(value + 'T12:00:00').toLocaleDateString(
      lang === 'ru' ? 'ru-RU' : 'en-GB',
      { day: 'numeric', month: 'short' },
    );
  const loadDrafts = async () =>
    setDrafts(
      actor && canEdit
        ? (await db.drafts.where('userId').equals(actor).toArray()).filter(
            (d) => !d.familyId || d.familyId === user?.familyId,
          )
        : [],
    );
  async function refresh() {
    const epoch = authEpoch();
    const data = await api('/state');
    if (epoch !== authEpoch()) return;
    setState(data.state);
    setGeneration(data.instanceGeneration);
    if (data.user !== undefined) setUser(data.user);
    setSession((session: any) => ({
      ...session,
      user: data.user ?? session?.user,
      storage: data.storage,
    }));
  }
  useEffect(() => {
    let live = true;
    setLoading(true);
    (async () => {
      const epoch = authEpoch();
      try {
        await db.values.delete('trusted-offline-copy');
        localStorage.removeItem('domovoy-trusted-offline');
        const data = await api('/session');
        if (!live || epoch !== authEpoch()) return;
        setSession(data);
        setUser(data.user);
        localStorage.setItem(
          'domovoy-instance',
          data.instanceId || location.origin,
        );
        if (data.user) await refresh();
      } catch (error) {
        if (live) {
          handleError(error);
          setAuthError((error as Error).message);
        }
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    void loadDrafts();
  }, [actor]);
  useEffect(() => {
    setToday(todayISO(state?.household.timezone));
  }, [state?.household.timezone]);
  useEffect(() => {
    if (
      !user ||
      !online ||
      !drafts.some((draft) => draft.operationId && draft.status !== 'blocked')
    )
      return;
    let cancelled = false;
    const poll = async () => {
      if (
        cancelled ||
        recoveryInFlight.current ||
        inFlight.current ||
        document.visibilityState !== 'visible'
      )
        return;
      recoveryInFlight.current = true;
      try {
        for (const d of drafts.filter(
          (d) => d.operationId && d.status !== 'blocked',
        )) {
          if (cancelled) break;
          const saved = await db.drafts.get(d.id);
          if (!saved?.operationId || saved.status === 'blocked') continue;
          let result;
          try {
            result = await api(`/operations/${d.operationId}`);
          } catch (e) {
            if ((e as ApiError).code !== 'OPERATION_NOT_FOUND') throw e;
            // A missing receipt is not proof that the original request cannot still arrive.
            // Reuse its exact ID/envelope so a late commit can never double the payment.
            if (!d.envelope) {
              await db.drafts.put({
                ...d,
                status: 'blocked',
                error: t(
                  'Запрос не найден; исходный пакет для безопасного повтора отсутствует.',
                  'No receipt or original request is available for a safe retry.',
                ),
              });
              await loadDrafts();
              continue;
            }
            try {
              result = await api('/commands', d.envelope);
            } catch (retryError) {
              if (await retainRejectedDraft(d, retryError)) {
                await loadDrafts();
                continue;
              }
              throw retryError;
            }
          }
          if (result.status === 'COMMITTED') {
            await db.drafts.delete(d.id);
            setError('');
            await refresh();
            await loadDrafts();
            setToast(
              t(
                'Операция подтверждена сервером',
                'Operation confirmed by server',
              ),
            );
          } else if (result.status === 'CANCELLED') {
            await db.drafts.put({
              ...d,
              status: 'draft',
              operationId: undefined,
              envelope: undefined,
            });
            await loadDrafts();
          }
        }
      } catch (e) {
        handleError(e);
      } finally {
        recoveryInFlight.current = false;
      }
    };
    const timer = setInterval(() => void poll(), 10000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user, online, drafts]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const items = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ) || [],
      ).filter((el) => el.offsetParent !== null);
    items()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && !busy && modal.type !== 'recoveryCodes')
        setModal(null);
      if (event.key === 'Tab') {
        const focusable = items();
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [modal?.type, busy]);
  useEffect(() => {
    const on = () => {
      setOnline(navigator.onLine);
      setToday(todayISO(state?.household.timezone));
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    window.addEventListener('focus', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
      window.removeEventListener('focus', on);
    };
  }, [state?.household.timezone]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!user || !online) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !inFlight.current)
        void api('/sync/state')
          .then((r) => {
            if (
              r.publishedRevision !== undefined &&
              r.publishedRevision !== state?.revision
            )
              void refresh().catch(handleError);
          })
          .catch(handleError);
    }, 60000);
    return () => clearInterval(timer);
  }, [user, online, state?.revision]);
  useEffect(() => {
    if (page !== 'settings' || !user) return;
    void api('/sessions')
      .then((r) => setSessions(r.sessions || r))
      .catch(handleError);
  }, [page, user]);
  function handleError(e: unknown) {
    const err = e as ApiError;
    setError(err.message);
    if (['SESSION_REVOKED', 'AUTH_REQUIRED'].includes(err.code)) {
      clearAuth();
      setState(null);
      setUser(null);
      setLease(null);
      setDrafts([]);

      void db.values.delete('trusted-offline-copy');
      setAuthError(
        t(
          'Сессия завершена. Войдите снова.',
          'Your session ended. Sign in again.',
        ),
      );
    }
  }
  async function acquire() {
    const result = await api('/edit-lease/acquire', { editorInstanceId });
    const value = result.lease || result;
    setLease(value);
    return value as Lease;
  }
  async function saveDraft(commands: Command[], label: string) {
    if (!state) return;
    await db.drafts.add({
      id: id(),
      userId: actor,
      familyId: user?.familyId,
      commands,
      label,
      createdAt: new Date().toISOString(),
      expectedRevision: state.revision,
    });
    await loadDrafts();
    setModal(null);
    setToast(
      t('Черновик сохранён на этом устройстве', 'Draft saved on this device'),
    );
  }
  async function retainRejectedDraft(
    draft: Draft,
    error: unknown,
    discardRejected = false,
  ): Promise<boolean> {
    const failure = error as ApiError;
    if (
      failure.status < 400 ||
      failure.status >= 500 ||
      [401, 408, 429].includes(failure.status)
    )
      return false;
    // A validation rejection leaves the open form available for correction, not a phantom operation.
    if (discardRejected && failure.status === 400) {
      await db.drafts.delete(draft.id);
      return true;
    }
    const ambiguous = failure.code === 'IDEMPOTENCY_MISMATCH';
    await db.drafts.put({
      ...draft,
      status: ambiguous ? 'blocked' : 'draft',
      error: failure.message,
      operationId: ambiguous ? draft.operationId : undefined,
      envelope: ambiguous ? draft.envelope : undefined,
    });
    return true;
  }
  async function submit(commands: Command[], label: string, draft?: Draft) {
    if (!state || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    let submittedDraft: Draft | undefined;
    try {
      if (!online) {
        await saveDraft(commands, label);
        return;
      }
      const active = lease || (await acquire());
      const operationId = draft?.operationId || id();
      const envelope = draft?.envelope || {
        operationId,
        protocolVersion: 1,
        instanceGeneration: generation,
        expectedRevision: draft?.expectedRevision ?? state.revision,
        leaseId: active.leaseId,
        fencingToken: active.fencingToken,
        editorInstanceId,
        commands,
      };
      const record: Draft = {
        id: draft?.id || id(),
        userId: actor,
        familyId: user?.familyId,
        commands,
        label,
        createdAt: draft?.createdAt || new Date().toISOString(),
        expectedRevision: state.revision,
        operationId,
        envelope,
        status: 'pending',
      };
      submittedDraft = record;
      await db.drafts.put(record);
      await loadDrafts();
      const result = await api('/commands', envelope);
      if (result.status === 'COMMITTED') {
        await db.drafts.delete(record.id);
        await refresh();
        setToast(t('Изменения подтверждены', 'Changes confirmed'));
      } else {
        setToast(
          t(
            'Сервер завершает сохранение. Статус — в черновиках.',
            'The server is finishing the save. Check Drafts for status.',
          ),
        );
      }
      setModal(null);
      await loadDrafts();
    } catch (e) {
      const failure = e as ApiError;
      if (
        submittedDraft &&
        (await retainRejectedDraft(submittedDraft, failure, !draft))
      ) {
        await loadDrafts();
      }
      handleError(e);
      if ((e as ApiError).code === 'REVISION_CONFLICT')
        await refresh().catch(handleError);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  async function checkDraft(draft: Draft) {
    if (!online) return;
    try {
      const r = await api(`/operations/${draft.operationId}`);
      if (r.status === 'COMMITTED') {
        await db.drafts.delete(draft.id);
        await refresh();
        await loadDrafts();
        setToast(t('Операция подтверждена', 'Operation confirmed'));
      } else {
        setToast(`${t('Состояние', 'Status')}: ${r.status}`);
        if (r.status === 'CANCELLED') {
          await db.drafts.put({
            ...draft,
            status: 'draft',
            operationId: undefined,
            envelope: undefined,
          });
          await loadDrafts();
        }
      }
    } catch (e) {
      if ((e as ApiError).code === 'OPERATION_NOT_FOUND' && draft.envelope) {
        await submit(draft.commands, draft.label, draft);
      } else handleError(e);
    }
  }
  async function login() {
    setBusy(true);
    setAuthError('');
    try {
      await startGoogleLogin();
    } catch (e) {
      setAuthError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      if (online) await api('/auth/logout', {});
      await revokeRefreshToken();
      clearAuth();
      setUser(null);
      setState(null);
      setLease(null);
      setDrafts([]);
      setModal(null);

      await db.values.delete('trusted-offline-copy');
    } catch (e) {
      handleError(e);
    }
  }
  function navigate(p: Page) {
    setPage(p);
    setSearch('');
    setFilter('all');
    setMobileMenu(false);
  }
  function moveMonth(delta: number) {
    const d = new Date(`${month}-15T12:00:00`);
    d.setMonth(d.getMonth() + delta);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  function showObligations(nextFilter: string) {
    navigate('obligations');
    setFilter(nextFilter);
  }
  const periodFrom = `${month}-01`,
    nextMonthDate = new Date(`${month}-15T12:00:00`);
  nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
  const periodTo = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}-01`;
  const financial =
    !!state?.rules &&
    ['admin', 'editor', 'own_editor', 'deleter', 'observer'].includes(
      user?.role || '',
    );
  const periods =
    state && financial
      ? generatePeriods(state, periodFrom, periodTo).filter(
          (p) => p.dueDate >= periodFrom && p.dueDate < periodTo,
        )
      : [];
  const enriched = periods
    .map((p) => ({
      period: p,
      obligation: state!.obligations.find((o) => o.id === p.obligationId)!,
      status: getPeriodStatus(state!, p, today),
    }))
    .filter((row) => row.obligation);
  const monthlyRows = state
    ? groupMonthlyObligations(state, periods, today)
    : [];
  const olderOverdue =
    state && financial
      ? state.periods.filter(
          (period) =>
            period.dueDate < periodFrom &&
            getPeriodStatus(state, period, today).timingState === 'overdue' &&
            getPeriodStatus(state, period, today).needsAction,
        )
      : [];
  const expected = periods.reduce(
      (sum, p) => sum + (periodBaseAmount(state!, p) || 0),
      0,
    ),
    allocated = enriched.reduce((sum, p) => sum + p.status.allocated, 0),
    remaining = enriched.reduce(
      (sum, p) => sum + Math.max(0, p.status.remaining || 0),
      0,
    ),
    overdue = monthlyRows.filter((row) => row.status === 'overdue'),
    paidCount = monthlyRows.filter((row) => row.status === 'paid').length;
  const filtered = monthlyRows.filter(
    (r) =>
      (r.obligation.title.toLowerCase().includes(search.toLowerCase()) ||
        state?.providers
          .find((p) => p.id === r.obligation.providerId)
          ?.name.toLowerCase()
          .includes(search.toLowerCase())) &&
      (filter === 'all' ||
        (filter === 'unpaid' && r.needsAction) ||
        (filter === 'paid' && r.status === 'paid') ||
        (filter === 'overdue' && r.status === 'overdue')),
  );
  const upcoming = [...enriched]
    .filter((r) => r.status.needsAction)
    .sort((a, b) => a.period.dueDate.localeCompare(b.period.dueDate))
    .slice(0, 4);
  function statusBadge(p: BillingPeriod) {
    const s = getPeriodStatus(state!, p, today);
    const key = s.settlementState;
    const names = {
      paid: t('Оплачено', 'Paid'),
      waived: t('Пропущено', 'Waived'),
      partial: t('Частично', 'Partial'),
      undetermined: t('Уточнить сумму', 'Confirm amount'),
      unpaid:
        s.timingState === 'overdue'
          ? t('Просрочено', 'Overdue')
          : t('К оплате', 'Upcoming'),
    };
    return (
      <span
        className={`status ${key === 'paid' || key === 'waived' ? 'green' : s.timingState === 'overdue' ? 'red' : key === 'partial' ? 'amber' : 'neutral'}`}
      >
        <span />
        {names[key]}
        {key === 'partial' && s.timingState === 'overdue'
          ? t(' · просрочено', ' · overdue')
          : ''}
      </span>
    );
  }
  function monthlyStatusBadge(row: MonthlyObligationRow) {
    const names = {
      paid: t('Оплачено', 'Paid'),
      due: t('К оплате', 'To pay'),
      overdue: t('Просрочено', 'Overdue'),
    };
    return (
      <span
        className={`status ${row.status === 'paid' ? 'green' : row.status === 'overdue' ? 'red' : 'neutral'}`}
      >
        <span />
        {names[row.status]}
      </span>
    );
  }
  function paymentModal(period?: BillingPeriod) {
    if (!state?.people.length) {
      setModal({ type: 'person' });
      setToast(t('Сначала добавьте плательщика', 'Add a payer first'));
      return;
    }
    setModal({ type: 'payment', data: period });
  }
  function periodCommands(): Command[] {
    return [
      { type: 'GeneratePeriods', payload: { from: periodFrom, to: periodTo } },
    ];
  }
  if (loading)
    return (
      <div className="loading-screen">
        <Brand lang={lang} />
        <LoaderCircle className="spin" />
        <p>{t('Наводим порядок…', 'Getting things ready…')}</p>
      </div>
    );
  if (session?.deleted || session?.deletion?.phase === 'RUNNING')
    return (
      <main className="auth-layout">
        <section className="auth-story">
          <Brand lang={lang} />
          <h1>
            {t(
              'Домохозяйство удалено или удаляется',
              'Household deleted or being deleted',
            )}
          </h1>
          <p>
            {t(
              'Доступ к этому реестру закрыт. Скачанные резервные копии остаются у администратора.',
              'Access to this registry is closed. Downloaded backups remain with the administrator.',
            )}
          </p>
        </section>
      </main>
    );
  if (session?.onboarding && !user)
    return (
      <>
        {languageButton(true)}
        <FamilyOnboarding
          t={t}
          onError={handleError}
          onComplete={async () => {
            const next = await api('/session');
            setSession(next);
            setUser(next.user);
            if (next.user) await refresh();
          }}
        />
      </>
    );
  if (!user)
    return (
      <main className="auth-layout">
        {languageButton(true)}
        <section className="auth-story">
          <Brand lang={lang} />
          <div>
            <span className="eyebrow">
              {t(
                'ОДИН ДОМ. ВСЁ ПОД КОНТРОЛЕМ.',
                'ONE HOME. ALL TAKEN CARE OF.',
              )}
            </span>
            <h1>
              {t(
                'Забот меньше.\nЖизни больше.',
                'Less to worry about.\nMore room for life.',
              )}
            </h1>
            <p>
              {t(
                'Подписки, счета и семейные расходы — в одном спокойном месте.',
                'Subscriptions, bills and family expenses, together in one calm place.',
              )}
            </p>
            <HouseArt />
          </div>
          <small>{t('Ваш дом. Ваши данные.', 'Your home. Your data.')}</small>
        </section>
        <section className="auth-form-wrap">
          <GoogleLogin
            t={t}
            busy={busy}
            error={authError}
            onLogin={() => void login()}
          ></GoogleLogin>
        </section>
        {toast && <div className="toast">{toast}</div>}
      </main>
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'open' : ''}`}>
        <Brand lang={lang} />
        <button
          className="household-switch"
          onClick={() => navigate('settings')}
        >
          <span className="household-icon">
            <Home size={19} />
          </span>
          <span>
            <strong>{state?.household.name || t('Наш дом', 'Our home')}</strong>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="nav-label">{t('ВАШЕ ПРОСТРАНСТВО', 'YOUR SPACE')}</div>
        <nav>
          {(['overview', 'obligations', 'payments', 'family'] as Page[])
            .filter((v) => financial || v === 'overview' || v === 'family')
            .map((p) => {
              const Icon = icons[p];
              return (
                <button
                  key={p}
                  className={`nav-item ${page === p ? 'active' : ''}`}
                  onClick={() => navigate(p)}
                >
                  <Icon size={19} />
                  {titles[p][lang === 'ru' ? 0 : 1]}
                  {p === 'obligations' && (
                    <span className="nav-count">
                      {state?.obligations.length || 0}
                    </span>
                  )}
                </button>
              );
            })}
          <div className="nav-divider" />
          {(['import', 'history', 'settings'] as Page[])
            .filter((p) => financial || p === 'settings')
            .map((p) => {
              const Icon = icons[p];
              return (
                <button
                  key={p}
                  className={`nav-item ${page === p ? 'active' : ''}`}
                  onClick={() => navigate(p)}
                >
                  <Icon size={19} />
                  {titles[p][lang === 'ru' ? 0 : 1]}
                </button>
              );
            })}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="profile-button"
            onClick={() => navigate('settings')}
          >
            <span className="avatar dark">
              {(user?.name || user?.login || 'А').slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>
                {user?.name || user?.login || t('Алексей', 'Alex')}
              </strong>
              <small>
                {isAdmin ? t('Администратор', 'Administrator') : user?.role}
              </small>
            </span>
            <Settings size={16} />
          </button>
        </div>
      </aside>
      {mobileMenu && (
        <button
          className="sidebar-overlay"
          aria-label="Close menu"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-toggle"
              aria-label="Menu"
              onClick={() => setMobileMenu(true)}
            >
              <Menu size={21} />
            </button>
            <Home size={15} />
            <span>{t('Наш дом', 'Our home')}</span>
            <ChevronRight size={13} />
            <strong>{titles[page][lang === 'ru' ? 0 : 1]}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="connection-status"
              onClick={() =>
                setModal({ type: drafts.length ? 'drafts' : 'connection' })
              }
            >
              {online ? (
                <span className="connection-dot" />
              ) : (
                <WifiOff size={14} />
              )}
              <span>
                {!!user
                  ? !online
                    ? t('Нет связи с сервером', 'Offline')
                    : busy
                      ? t('Сохранение…', 'Saving…')
                      : drafts.length
                        ? t(
                            `Не сохранено: ${drafts.length}`,
                            `Unsaved: ${drafts.length}`,
                          )
                        : error
                          ? t('Требуется проверка', 'Check connection')
                          : t('Данные синхронизированы', 'Data synchronized')
                  : t('Требуется вход', 'Sign-in required')}
              </span>
            </button>
            <span className="topbar-separator" />
            {languageButton()}
            <button
              className="icon-button notification-button"
              aria-label={t('Напоминания', 'Reminders')}
              onClick={() => setModal({ type: 'reminders' })}
            >
              <Bell size={19} />
              {upcoming.length > 0 && <i />}
            </button>
            <span className="avatar small-avatar">
              {(user?.name || user?.login || 'А').slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        <main className="main-content">
          {!online && (
            <div className="notice">
              <WifiOff size={17} />
              {t(
                'Нет сети. Изменения можно сохранить как черновики.',
                'You are offline. Changes can be saved as drafts.',
              )}
            </div>
          )}
          {error && (
            <div className="notice danger" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss"
                onClick={() => setError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {drafts.length > 0 && (
            <button
              className="draft-banner"
              onClick={() => setModal({ type: 'drafts' })}
            >
              <FileClock size={17} />
              {t(
                'Несохранённые изменения — открыть и проверить',
                'Unsaved changes — review and send',
              )}
              <strong>{drafts.length}</strong>
              <ArrowRight size={16} />
            </button>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === 'overview'
                  ? t(
                      'ДОМ, В КОТОРОМ ВСЁ В ПОРЯДКЕ',
                      'A HOME WITH EVERYTHING IN ORDER',
                    )
                  : t(
                      'СЕМЕЙНЫЕ ФИНАНСЫ БЕЗ СУЕТЫ',
                      'FAMILY FINANCES, WITHOUT THE FUSS',
                    )}
              </div>
              <h1>
                {page === 'overview'
                  ? t('Всё под контролем', 'Everything in order')
                  : titles[page][lang === 'ru' ? 0 : 1]}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {page === 'overview'
                  ? t(
                      'Все регулярные расходы семьи — в одном месте.',
                      'All your family’s recurring expenses, in one place.',
                    )
                  : page === 'obligations'
                    ? t(
                        'Подписки, счета и всё, что повторяется.',
                        'Subscriptions, bills and everything that repeats.',
                      )
                    : page === 'payments'
                      ? t(
                          'Каждый платёж на своём месте.',
                          'Every payment, in its place.',
                        )
                      : page === 'family'
                        ? t(
                            'Кто чем пользуется и за что отвечает.',
                            'Who has access and who takes care of what.',
                          )
                        : page === 'import'
                          ? t(
                              'Загрузите выписку, проверьте и подтвердите платежи.',
                              'Upload a statement, review and confirm payments.',
                            )
                          : page === 'history'
                            ? t(
                                'Прозрачная история всех подтверждённых изменений.',
                                'A clear record of every confirmed change.',
                              )
                            : t(
                                'Ваш дом устроен по вашим правилам.',
                                'Your home, your rules.',
                              )}
              </p>
            </div>
            {canEdit &&
              financial &&
              (page !== 'family' || isAdmin) &&
              (page === 'overview' ||
                page === 'obligations' ||
                page === 'payments' ||
                page === 'family') && (
                <button
                  className="button primary"
                  onClick={() =>
                    page === 'payments'
                      ? paymentModal()
                      : setModal({
                          type: page === 'family' ? 'person' : 'obligation',
                        })
                  }
                >
                  <Plus size={18} />
                  {page === 'payments'
                    ? t('Добавить платёж', 'Add payment')
                    : page === 'family'
                      ? t('Добавить человека', 'Add person')
                      : t('Добавить обязательство', 'Add obligation')}
                </button>
              )}
          </div>
          {(page === 'overview' || page === 'obligations') && financial && (
            <>
              <div className="period-bar">
                <div className="month-picker">
                  <button
                    className="icon-button"
                    aria-label={t('Предыдущий месяц', 'Previous month')}
                    onClick={() => moveMonth(-1)}
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <span>
                    {new Date(`${month}-15T12:00:00`)
                      .toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', {
                        month: 'long',
                        year: 'numeric',
                      })
                      .replace(' г.', '')}
                  </span>
                  <button
                    className="icon-button"
                    aria-label={t('Следующий месяц', 'Next month')}
                    onClick={() => moveMonth(1)}
                  >
                    <ChevronRight size={17} />
                  </button>
                </div>
                <button
                  className="text-button subdued"
                  onClick={() => setMonth(today.slice(0, 7))}
                >
                  {t('Текущий месяц', 'This month')}
                </button>
                <span className="period-spacer" />
                <span className="muted desktop-only">
                  {monthlyRows.length}{' '}
                  {t('обязательств в этом месяце', 'obligations this month')}
                </span>
              </div>
              {page === 'overview' && (
                <>
                  <section className="summary-grid">
                    <button
                      type="button"
                      className="summary-card"
                      onClick={() => showObligations('all')}
                      aria-label={t(
                        'План на месяц — все обязательства',
                        'Expected this month — all obligations',
                      )}
                    >
                      <div className="summary-label">
                        {t('План на месяц', 'Expected this month')}
                        <span className="metric-icon blue">
                          <Wallet size={18} />
                        </span>
                      </div>
                      <strong className="metric">{money(expected)}</strong>
                      <span className="metric-note">
                        {t(
                          'Начисления по дате оплаты',
                          'Scheduled by due date',
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="summary-card"
                      onClick={() => showObligations('paid')}
                      aria-label={t(
                        'Уже оплачено — оплаченные обязательства',
                        'Already covered — paid obligations',
                      )}
                    >
                      <div className="summary-label">
                        {t('Уже оплачено', 'Already covered')}
                        <span className="metric-icon mint">
                          <CheckCheck size={18} />
                        </span>
                      </div>
                      <strong className="metric">{money(allocated)}</strong>
                      <div className="metric-note">
                        <span className="tiny-dot green-dot" />
                        {paidCount} {t('из', 'of')} {monthlyRows.length}{' '}
                        {t('обязательств закрыто', 'obligations covered')}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="summary-card"
                      onClick={() => showObligations('unpaid')}
                      aria-label={t(
                        'Осталось оплатить — обязательства к оплате',
                        'Left to pay — unpaid obligations',
                      )}
                    >
                      <div className="summary-label">
                        {t('Осталось оплатить', 'Left to pay')}
                        <span className="metric-icon yellow">
                          <CreditCard size={18} />
                        </span>
                      </div>
                      <strong className="metric">{money(remaining)}</strong>
                      <span className="metric-note">
                        {monthlyRows.filter((r) => r.needsAction).length}{' '}
                        {t(
                          'обязательств ждут оплаты',
                          'obligations need attention',
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`summary-card ${overdue.length ? 'attention' : ''}`}
                      onClick={() => showObligations('unpaid')}
                      aria-label={t(
                        'Требует внимания — обязательства к оплате',
                        'Needs attention — unpaid obligations',
                      )}
                    >
                      <div className="summary-label">
                        {t('Требует внимания', 'Needs attention')}
                        <span className="metric-icon coral">
                          <Bell size={18} />
                        </span>
                      </div>
                      <strong className="metric">
                        {overdue.length}
                        <span className="metric-unit">
                          {t('просрочено', 'overdue')}
                        </span>
                      </strong>
                      <span className="metric-link">
                        {overdue.length
                          ? t('Посмотреть обязательства', 'View obligations')
                          : t('Можно выдохнуть', 'Take a breath')}
                        <ArrowUpRight size={14} />
                      </span>
                    </button>
                  </section>
                  <MonthlyCharts state={state!} month={month} t={t} />
                  {olderOverdue.length > 0 && (
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>
                          {t('Просрочки прошлых месяцев', 'Earlier arrears')}
                        </h2>
                      </div>
                      {olderOverdue.map((period) => (
                        <button
                          className="simple-row full"
                          key={period.id}
                          onClick={() =>
                            setModal({
                              type: 'detail',
                              data: {
                                period,
                                obligation: state!.obligations.find(
                                  (o) => o.id === period.obligationId,
                                ),
                              },
                            })
                          }
                        >
                          <span className="grow">
                            {
                              state!.obligations.find(
                                (o) => o.id === period.obligationId,
                              )?.title
                            }{' '}
                            · {date(period.dueDate)}
                          </span>
                          <strong>
                            {money(
                              getPeriodStatus(state!, period, today)
                                .remaining ?? 0,
                            )}
                          </strong>
                        </button>
                      ))}
                    </section>
                  )}
                </>
              )}
              <div className={page === 'overview' ? 'overview-columns' : ''}>
                <section className="panel obligations-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        {t('Обязательства месяца', 'This month’s obligations')}
                        <span className="count-pill">{monthlyRows.length}</span>
                      </h2>
                      <p>
                        {t(
                          'Ничего не забыть, ничего не переплатить.',
                          'Nothing forgotten, nothing paid twice.',
                        )}
                      </p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label={t('Обновить', 'Refresh')}
                      onClick={() => void refresh().catch(handleError)}
                    >
                      <RefreshCw size={17} />
                    </button>
                  </div>
                  <div className="table-toolbar">
                    <div className="tabs">
                      {[
                        ['all', t('Все', 'All')],
                        ['unpaid', t('К оплате', 'To pay')],
                        ['paid', t('Оплачено', 'Paid')],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          className={filter === key ? 'selected' : ''}
                          onClick={() => setFilter(key)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label className="search-box">
                      <Search size={16} />
                      <input
                        aria-label={t(
                          'Поиск обязательств',
                          'Search obligations',
                        )}
                        placeholder={t('Найти…', 'Search…')}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="expense-table">
                    <div className="expense-table-head">
                      <span>{t('ОБЯЗАТЕЛЬСТВО', 'OBLIGATION')}</span>
                      <span>{t('К ОПЛАТЕ', 'DUE')}</span>
                      <span>{t('СУММА', 'AMOUNT')}</span>
                      <span>{t('СТАТУС', 'STATUS')}</span>
                      <span />
                    </div>
                    {filtered.map((row) => {
                      const p = row.representative,
                        o = row.obligation,
                        beneficiary = beneficiaryPresentation(state!, o, t),
                        first = row.periods[0],
                        last = row.periods.at(-1)!,
                        multiple = row.periods.length > 1,
                        showPaidShare =
                          multiple &&
                          row.expected !== undefined &&
                          row.allocated > 0 &&
                          row.allocated < row.expected;
                      return (
                        <button
                          className="expense-row"
                          key={o.id}
                          onClick={() =>
                            setModal({
                              type: 'detail',
                              data: {
                                period: p,
                                periods: row.periods,
                                obligation: o,
                              },
                            })
                          }
                        >
                          <span className="service-cell">
                            <ServiceIcon
                              iconId={o.iconId}
                              iconColor={o.iconColor}
                              title={o.title}
                            />
                            <span>
                              <strong>{o.title}</strong>
                              <small>
                                {categoryLabel(
                                  o.category ??
                                    state?.providers.find(
                                      (provider) =>
                                        provider.id === o.providerId,
                                    )?.category,
                                  t,
                                )}
                                <span className="small-separator">·</span>
                                {state?.people.find(
                                  (person) => person.id === o.ownerPersonId,
                                )?.displayName ||
                                  t(
                                    'Ответственный не назначен',
                                    'No responsible person',
                                  )}
                              </small>
                              <small className="obligation-beneficiaries">
                                <span>{t('Пользуется', 'Benefits')}:</span>{' '}
                                <strong
                                  className="obligation-beneficiary-name"
                                  style={{
                                    color: beneficiary.color,
                                    fontWeight: 700,
                                  }}
                                >
                                  {beneficiary.label}
                                </strong>
                              </small>
                            </span>
                          </span>
                          <span
                            className="due-cell"
                            title={row.periods
                              .map((period) => date(period.dueDate))
                              .join(', ')}
                          >
                            {multiple
                              ? `${date(first.dueDate)} – ${date(last.dueDate)}`
                              : date(p.dueDate)}
                          </span>
                          <strong className="amount-cell">
                            {row.expected === undefined
                              ? '—'
                              : showPaidShare
                                ? `${money(row.allocated)} / ${money(row.expected)}`
                                : money(row.expected)}
                            {row.estimated && (
                              <small>{t('оценка', 'estimate')}</small>
                            )}
                          </strong>
                          <span className="status-cell">
                            {multiple
                              ? monthlyStatusBadge(row)
                              : statusBadge(p)}
                          </span>
                          <ChevronRight size={15} className="row-chevron" />
                        </button>
                      );
                    })}
                    {!filtered.length && (
                      <div className="empty-state">
                        <ListChecks size={32} />
                        <h3>{t('Здесь пока тихо', 'All quiet here')}</h3>
                        <p>
                          {search || filter !== 'all'
                            ? t(
                                'По этим условиям ничего не найдено.',
                                'Nothing matches these filters.',
                              )
                            : t(
                                'Добавьте первое обязательство или выберите другой месяц.',
                                'Add your first obligation or choose another month.',
                              )}
                        </p>
                        {canEdit && (
                          <button
                            className="button secondary"
                            onClick={() => setModal({ type: 'obligation' })}
                          >
                            <Plus size={16} />
                            {t('Добавить обязательство', 'Add obligation')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="table-footer">
                    <span>
                      {t('Показано', 'Showing')} {filtered.length}{' '}
                      {t('из', 'of')} {monthlyRows.length}
                    </span>
                    {page === 'overview' && (
                      <button
                        className="text-button"
                        onClick={() => navigate('obligations')}
                      >
                        {t('Все обязательства', 'All obligations')}
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                </section>
                {page === 'overview' && (
                  <aside className="right-column">
                    <section className="panel upcoming-panel">
                      <div className="panel-heading">
                        <h2>{t('На очереди', 'Coming up')}</h2>
                        <span className="soft-icon">
                          <Bell size={16} />
                        </span>
                      </div>
                      <p className="side-description">
                        {t(
                          'Ближайшее, о чём стоит помнить.',
                          'A little heads-up for your household.',
                        )}
                      </p>
                      <div className="upcoming-items">
                        {upcoming.map(({ period: p, obligation: o }) => (
                          <button
                            className="upcoming-item"
                            key={p.id}
                            onClick={() =>
                              setModal({
                                type: 'detail',
                                data: { period: p, obligation: o },
                              })
                            }
                          >
                            <span className="date-tile">
                              <strong>{Number(p.dueDate.slice(8))}</strong>
                              <small>
                                {new Date(p.dueDate + 'T12:00:00')
                                  .toLocaleDateString(lang, { month: 'short' })
                                  .replace('.', '')}
                              </small>
                            </span>
                            <span>
                              <strong>{o.title}</strong>
                              <small>
                                {periodBaseAmount(state!, p) === undefined
                                  ? t('Уточнить сумму', 'Confirm amount')
                                  : money(periodBaseAmount(state!, p) ?? 0)}
                              </small>
                            </span>
                            <ChevronRight size={14} />
                          </button>
                        ))}
                        {!upcoming.length && (
                          <div className="all-paid">
                            <CheckCheck size={30} />
                            <strong>
                              {t('Всё оплачено', 'All taken care of')}
                            </strong>
                            <p>
                              {t(
                                'Этот месяц в порядке.',
                                'This month is in order.',
                              )}
                            </p>
                          </div>
                        )}
                      </div>
                      <button
                        className="text-button full"
                        onClick={() => setModal({ type: 'reminders' })}
                      >
                        {t('Все напоминания', 'All reminders')}
                        <ArrowRight size={15} />
                      </button>
                    </section>
                  </aside>
                )}
              </div>
            </>
          )}
          {!financial && state && page !== 'settings' && (
            <RestrictedView state={state} t={t} />
          )}
          {page === 'payments' && financial && (
            <>
              <div
                className="product-tabs product-payments-tabs"
                role="tablist"
                aria-label={t('Платежи', 'Payments')}
              >
                <button
                  role="tab"
                  aria-selected={paymentTab === 'payments'}
                  onClick={() => setPaymentTab('payments')}
                >
                  {t('Платежи', 'Payments')}
                </button>
                <button
                  role="tab"
                  aria-selected={paymentTab === 'automatic'}
                  onClick={() => setPaymentTab('automatic')}
                >
                  {t('Автоплатежи', 'Automatic payments')}
                </button>
              </div>
              {paymentTab === 'automatic' && state && (
                <AutomaticPaymentsPanel
                  state={state}
                  t={t}
                  canEdit={canEdit}
                  canDelete={canManageEntity}
                  onAdd={() => setModal({ type: 'automaticPayment' })}
                  onDelete={(scheduleId) =>
                    void submit(
                      [
                        {
                          type: 'DeleteAutomaticPayment',
                          payload: { scheduleId },
                        },
                      ],
                      t('Удаление автоплатежа', 'Delete automatic payment'),
                    )
                  }
                />
              )}
            </>
          )}
          {page === 'payments' && financial && paymentTab === 'payments' && (
            <section className="panel">
              <div className="panel-heading">
                <h2>
                  {t('Все платежи', 'All payments')}
                  <span className="count-pill">
                    {state?.payments.length || 0}
                  </span>
                </h2>
                <button
                  className="button secondary"
                  onClick={() => navigate('import')}
                >
                  <FileUp size={16} />
                  {t('Импорт CSV', 'Import CSV')}
                </button>
              </div>
              {[...(state?.payments || [])]
                .sort((a, b) => b.paidAt.localeCompare(a.paidAt))
                .map((payment) => {
                  const used = state!.allocations
                    .filter((a) => a.paymentId === payment.id && !a.reversedBy)
                    .reduce((s, a) => s + a.amount, 0);
                  const refunded = state!.refunds
                    .filter((r) => r.originalPaymentId === payment.id)
                    .reduce((s, r) => s + (r.baseAmount ?? r.amount), 0);
                  return (
                    <button
                      className="payment-row"
                      key={payment.id}
                      onClick={() =>
                        setModal({ type: 'paymentDetail', data: payment })
                      }
                    >
                      <span className="payment-symbol">
                        <ArrowDownLeft size={21} />
                      </span>
                      <span className="grow">
                        <strong>
                          {payment.descriptor || t('Платёж', 'Payment')}
                        </strong>
                        <small>
                          {date(payment.paidAt)} ·{' '}
                          {
                            state?.people.find(
                              (p) => p.id === payment.payerPersonId,
                            )?.displayName
                          }{' '}
                          ·{' '}
                          {payment.source === 'csv'
                            ? 'CSV'
                            : payment.source === 'automatic'
                              ? t('Автоплатёж', 'Automatic')
                              : t('Вручную', 'Manual')}
                        </small>
                      </span>
                      <span className="payment-right">
                        <strong>{money(paymentBaseAmount(payment))}</strong>
                        {payment.currency !== state!.household.currency && (
                          <small>
                            {formatMoney(payment.amount, payment.currency)}
                          </small>
                        )}
                        <small>
                          {refunded
                            ? `${t('Возврат', 'Refund')}: ${money(refunded)}`
                            : `${t('Не распределено', 'Unallocated')}: ${money(paymentBaseAmount(payment) - used - refunded)}`}
                        </small>
                      </span>
                      <ChevronRight size={17} />
                    </button>
                  );
                })}
              {!state?.payments.length && (
                <div className="empty-state">
                  <Wallet size={35} />
                  <h3>
                    {t(
                      'История начинается с первого платежа',
                      'Every history starts with a first payment',
                    )}
                  </h3>
                  <button
                    className="button primary"
                    onClick={() => paymentModal()}
                  >
                    <Plus size={16} />
                    {t('Добавить платёж', 'Add payment')}
                  </button>
                </div>
              )}
            </section>
          )}
          {page === 'family' && financial && state && (
            <>
              <FamilyAccessPanel
                state={state}
                today={today}
                user={user!}
                t={t}
                onChange={refresh}
                onSavePerson={(personId, patch) =>
                  submit(
                    [{ type: 'UpdatePerson', payload: { personId, patch } }],
                    t('Изменён участник семьи', 'Household member updated'),
                  )
                }
                saving={busy}
                operationError={error}
                onOpen={(obligation) =>
                  setModal({
                    type: 'detail',
                    data: {
                      obligation,
                      period: periods.find(
                        (period) => period.obligationId === obligation.id,
                      ),
                    },
                  })
                }
              />
            </>
          )}
          {page === 'history' && financial && (
            <section className="panel">
              <div className="panel-heading">
                <h2>{t('Журнал изменений', 'Activity log')}</h2>
                <span className="muted">
                  {t('Ревизия', 'Revision')} {state?.revision}
                </span>
              </div>
              {[...(state?.audit || [])]
                .reverse()
                .slice(0, 100)
                .map((event) => (
                  <div className="history-row" key={event.id}>
                    <span className="history-dot">
                      <Check size={15} />
                    </span>
                    <span className="grow">
                      <strong>
                        {(
                          {
                            AddObligation: t(
                              'Добавлено обязательство',
                              'Obligation added',
                            ),
                            RecordPaymentAndAllocate: t(
                              'Записан платёж',
                              'Payment recorded',
                            ),
                            AddPerson: t('Добавлен член семьи', 'Person added'),
                            GeneratePeriods: t(
                              'Созданы начисления',
                              'Billing periods generated',
                            ),
                            ArchiveObligation: t(
                              'Обязательство архивировано',
                              'Obligation archived',
                            ),
                            ImportPayments: t(
                              'Импортированы платежи',
                              'Payments imported',
                            ),
                            RefundPayment: t(
                              'Записан возврат',
                              'Refund recorded',
                            ),
                            UpdateHousehold: t(
                              'Обновлены настройки',
                              'Settings updated',
                            ),
                          } as Record<string, string>
                        )[event.action] || event.action}
                      </strong>
                      <small>
                        {event.reason ||
                          `${t('Автор', 'By')}: ${event.actorUserId.slice(0, 8)}`}
                      </small>
                    </span>
                    <time>
                      {new Date(event.serverTimestamp).toLocaleString(lang)}
                    </time>
                  </div>
                ))}
              {!state?.audit.length && (
                <div className="empty-state">
                  <FileClock size={32} />
                  <p>
                    {t(
                      'Здесь появятся подтверждённые изменения.',
                      'Confirmed changes will appear here.',
                    )}
                  </p>
                </div>
              )}
            </section>
          )}
          {page === 'import' && financial && state && (
            <PeriodReports state={state} t={t} />
          )}
          {page === 'import' && financial && (
            <section className="panel import-panel">
              <div className="panel-heading">
                <h2>
                  {t('Импорт банковской выписки', 'Import a bank statement')}
                </h2>
                <span className="badge-soft">CSV · UTF-8</span>
              </div>
              <div className="import-content">
                <div className="notice">
                  {t(
                    'Сначала предпросмотр. Импорт добавляет платежи; распределение на обязательства подтверждается отдельно.',
                    'Preview first. Import creates payments; allocations to obligations are confirmed separately.',
                  )}
                </div>
                <label className="upload-zone">
                  <span className="upload-icon">
                    <FileUp size={30} />
                  </span>
                  <strong>{t('Выберите CSV-файл', 'Choose a CSV file')}</strong>
                  <span>
                    {t(
                      'или вставьте содержимое ниже',
                      'or paste its contents below',
                    )}
                  </span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        if (file.size > 2 * 1024 * 1024) {
                          setError(
                            t(
                              'Максимальный размер — 2 МБ',
                              'Maximum size is 2 MB',
                            ),
                          );
                          return;
                        }
                        setCsv(await file.text());
                        setCsvPreview(null);
                      }
                    }}
                  />
                </label>
                <Field
                  label={t('Данные CSV', 'CSV contents')}
                  hint="date,amount,currency,description,reference"
                >
                  <textarea
                    rows={6}
                    value={csv}
                    onChange={(e) => {
                      setCsv(e.target.value);
                      setCsvPreview(null);
                    }}
                    placeholder={
                      'date,amount,currency,description,reference\n2026-09-07,12.99,EUR,Spotify,bank-001'
                    }
                  />
                </Field>
                <div className="import-controls">
                  <Field label={t('Плательщик', 'Payer')}>
                    <select
                      value={csvPayer || state?.people[0]?.id || ''}
                      onChange={(e) => setCsvPayer(e.target.value)}
                    >
                      {state?.people.map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <button
                    className="button primary"
                    disabled={!csv.trim()}
                    onClick={() => {
                      try {
                        setCsvPreview(
                          previewCsv(
                            csv,
                            state!,
                            csvPayer || state!.people[0]?.id || '',
                          ),
                        );
                      } catch (e) {
                        handleError(e);
                      }
                    }}
                  >
                    <Search size={17} />
                    {t('Проверить файл', 'Preview import')}
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      download(
                        'domovoy-import-example.csv',
                        `date,amount,currency,description,reference\n${today},12.99,${state?.household.currency},Spotify,sample-001`,
                        'text/csv',
                      )
                    }
                  >
                    {t('Скачать пример', 'Download example')}
                    <Download size={15} />
                  </button>
                </div>
                {csvPreview && (
                  <CsvResults
                    preview={csvPreview}
                    t={t}
                    money={money}
                    busy={busy}
                    onImport={(payments) =>
                      void submit(
                        [{ type: 'ImportPayments', payload: { payments } }],
                        t('Импорт CSV', 'CSV import'),
                      )
                    }
                  />
                )}
              </div>
            </section>
          )}
          {page === 'settings' && (
            <div className="settings-layout">
              <div className="settings-column">
                <AppearanceSettings t={t} />
                {
                  <section className="panel settings-section">
                    <div className="panel-heading">
                      <h2>{t('Устройства и сессии', 'Devices & sessions')}</h2>
                      <ShieldCheck size={19} />
                    </div>
                    <div className="settings-body">
                      {sessions.map((s) => (
                        <div className="simple-row" key={s.id}>
                          <span className="grow">
                            <strong>
                              {s.deviceName ||
                                s.deviceId ||
                                t('Браузер', 'Browser')}
                            </strong>
                            <small>
                              {s.login || s.userId?.slice(0, 8)}
                              {s.revokedAt
                                ? ` · ${t('Завершена', 'Revoked')}`
                                : ''}
                            </small>
                          </span>
                          {!s.revokedAt && (
                            <button
                              className="text-button"
                              onClick={() =>
                                void api(`/sessions/${s.id}/revoke`, {})
                                  .then(async () => {
                                    const r = await api('/sessions');
                                    setSessions(r.sessions || r);
                                  })
                                  .catch(handleError)
                              }
                            >
                              {t('Завершить', 'Revoke')}
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        className="button secondary"
                        onClick={() => void logout()}
                      >
                        <LogOut size={16} />
                        {t('Выйти из аккаунта', 'Sign out')}
                      </button>
                    </div>
                  </section>
                }
              </div>
              <div className="settings-column">
                <section className="panel settings-section">
                  <div className="panel-heading">
                    <h2>{t('Домохозяйство', 'Household')}</h2>
                    <Home size={19} />
                  </div>
                  {state && financial && (
                    <HouseholdPreferences
                      key={`${state.household.currency}:${state.household.color ?? ''}`}
                      state={state}
                      t={t}
                      isAdmin={isAdmin}
                      busy={busy}
                      submit={submit}
                    />
                  )}
                </section>

                {state && user && (
                  <FamilyAccountSettings
                    user={user}
                    state={state}
                    t={t}
                    onChange={async () => {
                      const next = await api('/session');
                      setSession(next);
                      setUser(next.user);
                      if (next.user) await refresh();
                      else setState(null);
                    }}
                  />
                )}
              </div>
            </div>
          )}
          <footer className="page-footer">
            <span>
              <span className="footer-home">
                <Home size={13} />
              </span>
              {t(
                'Домовой — заботится о важном',
                'Domovoy — taking care of what matters',
              )}
            </span>
            <button
              className="text-button subdued"
              onClick={() => setModal({ type: 'help' })}
            >
              <CircleHelp size={14} />
              {t('Как это работает', 'How it works')}
            </button>
          </footer>
        </main>
      </div>
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className={`modal ${['obligation', 'detail', 'payment', 'paymentDetail', 'drafts'].includes(modal.type) ? 'modal-wide' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="icon-button modal-close"
              aria-label={t('Закрыть', 'Close')}
              onClick={() => setModal(null)}
              disabled={busy}
            >
              <X size={21} />
            </button>
            {error && <div className="notice danger">{error}</div>}
            <ModalContent
              key={`${modal.type}:${modal.data?.id || modal.data?.period?.id || modal.data?.obligation?.id || ''}`}
              modal={modal}
              state={state!}
              t={t}
              money={money}
              date={date}
              today={today}
              month={month}
              periods={periods}
              busy={busy}
              canEdit={canManageModal()}
              canCreate={canEdit}
              canDelete={canManageModal()}
              canDeleteFull={isAdmin}
              isAdmin={isAdmin}
              drafts={drafts}
              statusBadge={statusBadge}
              monthlyStatusBadge={monthlyStatusBadge}
              close={() => setModal(null)}
              open={setModal}
              submit={submit}
              saveDraft={saveDraft}
              handleError={handleError}
              periodCommands={periodCommands}
              checkDraft={checkDraft}
              refreshDrafts={loadDrafts}
              setToast={setToast}
              setLease={setLease}
            />
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={18} />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss"
            onClick={() => setToast('')}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function RestrictedView({
  state,
  t,
}: {
  state: State;
  t: (a: string, b: string) => string;
}) {
  const labels: Record<string, string> = {
    paid: t('Оплачено', 'Paid'),
    unpaid: t('Ожидается оплата', 'Awaiting payment'),
    partial: t('Частично оплачено', 'Partially paid'),
    waived: t('Освобождено', 'Waived'),
    undetermined: t('Уточняется', 'To be confirmed'),
    overdue: t('Просрочено', 'Overdue'),
    due: t('Срок сегодня', 'Due today'),
    upcoming: t('Предстоит', 'Upcoming'),
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{t('Доступные вам сервисы', 'Your available services')}</h2>
      </div>
      {state.obligations.map((o) => (
        <div className="restricted-service" key={o.id}>
          <div className="simple-row">
            <ServiceIcon
              iconId={o.iconId}
              iconColor={o.iconColor}
              title={o.title}
            />
            <strong>{o.title}</strong>
          </div>
          {state.periods
            .filter((v) => v.obligationId === o.id)
            .slice(-12)
            .map((period) => {
              const status = (
                period as unknown as {
                  status?: {
                    settlementState: string;
                    timingState: string;
                  };
                }
              ).status;
              return (
                <div className="restricted-period" key={period.id}>
                  <span>
                    {period.periodStart} — {period.periodEnd}
                  </span>
                  {status && (
                    <span
                      className={`status ${status.settlementState === 'paid' ? 'green' : status.timingState === 'overdue' ? 'red' : 'neutral'}`}
                    >
                      {labels[status.settlementState] || status.settlementState}
                      {!['paid', 'waived'].includes(status.settlementState)
                        ? ` · ${labels[status.timingState] || status.timingState}`
                        : ''}
                    </span>
                  )}
                </div>
              );
            })}
          {state.entitlements
            .filter((v) => v.obligationId === o.id)
            .map((entitlement) => {
              const account = state.accounts.find(
                (a) => a.id === entitlement.serviceAccountId,
              );
              return (
                <div className="restricted-period" key={entitlement.id}>
                  <span>
                    {account?.label || t('Доступ назначен', 'Access assigned')}
                    {account?.usernameHint ? ` · ${account.usernameHint}` : ''}
                  </span>
                  {account?.externalUrl &&
                    /^https?:\/\//.test(account.externalUrl) && (
                      <a
                        className="text-button"
                        href={account.externalUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('Открыть', 'Open')}
                        <ExternalLink size={14} />
                      </a>
                    )}
                </div>
              );
            })}
        </div>
      ))}
      {!state.obligations.length && (
        <div className="empty-state">
          <Users />
          <p>
            {t(
              'Администратор ещё не назначил вам сервисы.',
              'Your administrator has not assigned any services yet.',
            )}
          </p>
        </div>
      )}
    </section>
  );
}
function CsvResults({
  preview,
  t,
  money,
  busy,
  onImport,
}: {
  preview: any;
  t: (a: string, b: string) => string;
  money: (n: number) => string;
  busy: boolean;
  onImport: (payments: Payment[]) => void;
}) {
  const [accepted, setAccepted] = useState<number[]>([]);
  const rows: any[] = Array.isArray(preview) ? preview : preview.rows || [];
  useEffect(() => setAccepted([]), [preview]);
  const payments: Payment[] =
    preview.payments ||
    rows
      .filter(
        (r) =>
          !r.duplicate &&
          !r.errors?.length &&
          r.payment &&
          (!r.possibleDuplicate || accepted.includes(r.rowNumber)),
      )
      .map((r) => r.payment);
  return (
    <div className="csv-results">
      <h3>{t('Результат проверки', 'Preview results')}</h3>
      {preview.errors?.map((e: any, i: number) => (
        <div className="notice danger" key={i}>
          {typeof e === 'string' ? e : e.message}
        </div>
      ))}
      {rows.map((r, i) => (
        <div className="simple-row" key={i}>
          <span>{r.rowNumber || r.row || i + 2}</span>
          {r.possibleDuplicate && !r.duplicate && (
            <label className="csv-duplicate-choice">
              <input
                type="checkbox"
                checked={accepted.includes(r.rowNumber)}
                onChange={(e) =>
                  setAccepted(
                    e.target.checked
                      ? [...accepted, r.rowNumber]
                      : accepted.filter((n) => n !== r.rowNumber),
                  )
                }
              />
              {t('Это другой платёж', 'This is a separate payment')}
            </label>
          )}
          <span className="grow">
            <strong>
              {r.payment?.descriptor ||
                r.description ||
                r.raw?.description ||
                '—'}
            </strong>
            <small>
              {r.errors?.join(', ') ||
                r.message ||
                r.reason ||
                (r.duplicate
                  ? t('Дубликат — пропускаем', 'Duplicate - skipped')
                  : t('Готов к импорту', 'Ready to import'))}
            </small>
          </span>
          <span>{r.payment && money(r.payment.amount)}</span>
          <span
            className={`status ${!r.duplicate && !r.errors?.length ? 'green' : 'amber'}`}
          >
            {r.errors?.length
              ? t('Ошибка', 'Error')
              : r.duplicate
                ? t('Дубликат', 'Duplicate')
                : r.possibleDuplicate
                  ? t('Похожий платёж', 'Possible duplicate')
                  : t('Готов', 'Ready')}
          </span>
        </div>
      ))}
      {!rows.length && (
        <pre className="preview-json">{JSON.stringify(preview, null, 2)}</pre>
      )}
      <button
        className="button primary"
        disabled={busy || !payments.length}
        onClick={() => onImport(payments)}
      >
        <Check size={16} />
        {t('Подтвердить импорт', 'Confirm import')} ({payments.length})
      </button>
    </div>
  );
}
type ModalProps = {
  modal: NonNullable<Modal>;
  state: State;
  t: (ru: string, en: string) => string;
  money: (n: number) => string;
  date: (s: string) => string;
  today: string;
  month: string;
  periods: BillingPeriod[];
  busy: boolean;
  canEdit: boolean;
  canCreate?: boolean;
  canDelete: boolean;
  canDeleteFull?: boolean;
  isAdmin: boolean;
  drafts: Draft[];
  statusBadge: (p: BillingPeriod) => ReactNode;
  monthlyStatusBadge: (row: MonthlyObligationRow) => ReactNode;
  close: () => void;
  open: (m: Modal) => void;
  submit: (c: Command[], label: string, draft?: Draft) => Promise<void>;
  saveDraft: (c: Command[], label: string) => Promise<void>;
  handleError: (e: unknown) => void;
  periodCommands: () => Command[];
  checkDraft: (d: Draft) => Promise<void>;
  refreshDrafts: () => Promise<void>;
  setToast: (v: string) => void;
  setLease: (v: Lease | null) => void;
};
function MatchSuggestions({
  state,
  periods,
  payment,
  today,
  t,
  money,
  selected,
  choose,
}: {
  state: State;
  periods: BillingPeriod[];
  payment: Payment;
  today: string;
  t: (a: string, b: string) => string;
  money: (n: number) => string;
  selected: string;
  choose: (id: string) => void;
}) {
  const available =
    paymentBaseAmount(payment) -
    state.allocations
      .filter((a) => a.paymentId === payment.id && !a.reversedBy)
      .reduce((sum, a) => sum + a.amount, 0) -
    state.refunds
      .filter((r) => r.originalPaymentId === payment.id)
      .reduce((sum, r) => sum + (r.baseAmount ?? r.amount), 0);
  const candidates = periods
    .map((period) => {
      const status = getPeriodStatus(state, period, today);
      const obligation = state.obligations.find(
        (o) => o.id === period.obligationId,
      )!;
      const nameMatches =
        !!payment.descriptor &&
        obligation.title
          .toLowerCase()
          .split(/\s+/)
          .some(
            (word) =>
              word.length > 2 &&
              payment.descriptor!.toLowerCase().includes(word),
          );
      const sameAmount = status.remaining === available;
      const closeDate =
        Math.abs(Date.parse(period.dueDate) - Date.parse(payment.paidAt)) <=
        7 * 86400000;
      return {
        period,
        obligation,
        status,
        nameMatches,
        sameAmount,
        closeDate,
        score:
          (nameMatches ? 50 : 0) + (sameAmount ? 30 : 0) + (closeDate ? 20 : 0),
      };
    })
    .filter((c) => c.status.needsAction && c.score > 0 && available > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!candidates.length) return null;
  return (
    <div className="match-suggestions">
      <h3>{t('Возможные совпадения', 'Suggested matches')}</h3>
      <p>
        {t(
          'Баллы отражают совпадение признаков. Выбор не подтверждает распределение автоматически.',
          'Scores describe matching signals. Selecting a suggestion does not automatically allocate the payment.',
        )}
      </p>
      {candidates.map((c) => (
        <button
          key={c.period.id}
          type="button"
          className={`match-candidate ${selected === c.period.id ? 'selected' : ''}`}
          onClick={() => choose(c.period.id)}
        >
          <span>
            <strong>{c.obligation.title}</strong>
            <small>
              {[
                c.nameMatches ? t('Название +50', 'Name +50') : '',
                c.sameAmount ? t('Сумма +30', 'Amount +30') : '',
                c.closeDate ? t('Дата +20', 'Date +20') : '',
              ]
                .filter(Boolean)
                .join(' · ')}{' '}
              · {c.status.remaining === null ? '?' : money(c.status.remaining)}
            </small>
          </span>
          <b>
            {c.score} {t('б.', 'pts')}
          </b>
          {selected === c.period.id && <Check size={14} />}
        </button>
      ))}
    </div>
  );
}
function ModalContent(p: ModalProps) {
  const {
    modal,
    state,
    t,
    money,
    date,
    today,
    periods,
    busy,
    canEdit,
    submit,
    close,
  } = p;
  const [localError, setLocalError] = useState(''),
    [selected, setSelected] = useState<string>(
      modal.type === 'payment' ? modal.data?.id || '' : '',
    );
  const title = (text: string, subtitle?: string) => (
    <>
      <h2 id="modal-title">{text}</h2>
      {subtitle && <p className="modal-subtitle">{subtitle}</p>}
      {localError && (
        <div className="notice danger" role="alert">
          {localError}
        </div>
      )}
    </>
  );
  function catchForm(fn: (f: FormData) => void) {
    return (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setLocalError('');
      try {
        fn(new FormData(e.currentTarget));
      } catch (e) {
        setLocalError((e as Error).message);
      }
    };
  }
  if (modal.type === 'scheduleObligation' || modal.type === 'archive')
    return (
      <ObligationScheduleEditor
        {...p}
        obligation={modal.data}
        archive={modal.type === 'archive'}
      />
    );
  if (modal.type === 'deleteObligation' && p.canDeleteFull)
    return <ObligationDeleteDialog {...p} obligation={modal.data} />;
  if (modal.type === 'billingRule')
    return (
      <PriceChangeEditor
        {...p}
        obligation={modal.data.obligation ?? modal.data}
        period={modal.data.period}
      />
    );
  if (modal.type === 'priceHistory')
    return <PriceHistory {...p} obligation={modal.data} />;
  if (modal.type === 'obligation' || modal.type === 'editObligation')
    return (
      <ObligationEditor
        {...p}
        obligation={modal.type === 'editObligation' ? modal.data : undefined}
      />
    );
  if (modal.type === 'person')
    return <PersonEditor {...p} person={modal.data} />;
  if (modal.type === 'automaticPayment')
    return <AutomaticPaymentEditor {...p} />;
  if (modal.type === 'payment')
    return <PaymentEditor {...p} period={modal.data} />;
  if (modal.type === 'detail') {
    const o = modal.data.obligation as Obligation,
      period = modal.data.period as BillingPeriod | undefined,
      detailPeriods =
        (modal.data.periods as BillingPeriod[] | undefined) ??
        (period ? [period] : []),
      monthlyRow =
        detailPeriods.length > 1
          ? groupMonthlyObligations(state, detailPeriods, today)[0]
          : undefined;
    const rule = period
      ? state.rules.find((r) => r.id === period.ruleVersionId)
      : state.rules
          .filter(
            (r) =>
              r.obligationId === o.id &&
              !r.superseded &&
              r.effectiveFrom <= today &&
              (!r.effectiveTo || r.effectiveTo > today),
          )
          .at(-1);
    const detailPeriodIds = new Set(detailPeriods.map((item) => item.id));
    const allocations = state.allocations.filter(
      (a) => detailPeriodIds.has(a.billingPeriodId) && !a.reversedBy,
    );
    const showPaidShare =
      monthlyRow?.expected !== undefined &&
      monthlyRow.allocated > 0 &&
      monthlyRow.allocated < monthlyRow.expected;
    return (
      <>
        <div className="detail-title">
          <ServiceIcon
            iconId={o.iconId}
            iconColor={o.iconColor}
            title={o.title}
          />
          {title(
            o.title,
            state.providers.find((v) => v.id === o.providerId)?.name,
          )}
        </div>
        {period && (
          <div className="detail-amount">
            <strong>
              {monthlyRow
                ? monthlyRow.expected === undefined
                  ? '—'
                  : showPaidShare
                    ? `${p.money(monthlyRow.allocated)} / ${p.money(monthlyRow.expected)}`
                    : p.money(monthlyRow.expected)
                : period.expectedAmount === undefined
                  ? '—'
                  : formatMoney(
                      period.expectedAmount,
                      rule?.currency ?? state.household.currency,
                    )}
            </strong>
            {monthlyRow
              ? p.monthlyStatusBadge(monthlyRow)
              : p.statusBadge(period)}
          </div>
        )}
        <div className="detail-grid">
          <span>
            <small>{t('Категория', 'Category')}</small>
            <strong>
              {categoryLabel(
                o.category ??
                  state.providers.find(
                    (provider) => provider.id === o.providerId,
                  )?.category,
                t,
              )}
            </strong>
          </span>
          <span>
            <small>{t('Ответственный', 'Owner')}</small>
            <strong>
              {state.people.find((v) => v.id === o.ownerPersonId)
                ?.displayName ?? t('Не назначен', 'Not assigned')}
            </strong>
          </span>
          <span>
            <small>{t('График', 'Schedule')}</small>
            <strong>
              {rule?.cadence === 'weekly'
                ? t('Еженедельно', 'Weekly')
                : rule?.cadence === 'yearly'
                  ? t('Ежегодно', 'Yearly')
                  : rule?.cadence === 'quarterly'
                    ? t('Ежеквартально', 'Quarterly')
                    : t('Ежемесячно', 'Monthly')}
            </strong>
          </span>
          <span>
            <small>{t('Дата оплаты', 'Due date')}</small>
            <strong>
              {monthlyRow
                ? `${date(monthlyRow.periods[0].dueDate)} – ${date(monthlyRow.periods.at(-1)!.dueDate)}`
                : period
                  ? date(period.dueDate)
                  : '—'}
            </strong>
          </span>
          <span>
            <small>{t('Кто пользуется', 'Beneficiaries')}</small>
            <strong>{beneficiaryLabel(state, o, t)}</strong>
          </span>
        </div>
        {period && (
          <>
            <h3>{t('Распределённые платежи', 'Allocated payments')}</h3>
            {allocations.map((a) => {
              const pay = state.payments.find((v) => v.id === a.paymentId);
              return (
                <div className="simple-row" key={a.id}>
                  <CheckCheck size={18} />
                  <span className="grow">
                    {pay ? date(pay.paidAt) : ''} ·{' '}
                    {
                      state.people.find((v) => v.id === pay?.payerPersonId)
                        ?.displayName
                    }
                  </span>
                  <strong>{money(a.amount)}</strong>
                </div>
              );
            })}
            {!allocations.length && (
              <p className="muted">
                {t(
                  'На это начисление пока нет распределений.',
                  'No payments have been allocated to this period yet.',
                )}
              </p>
            )}
          </>
        )}
        <div className="detail-actions">
          {p.canCreate && period && (
            <button
              className="button primary"
              onClick={() => p.open({ type: 'payment', data: period })}
            >
              <Plus size={17} />
              {t('Записать платёж', 'Record payment')}
            </button>
          )}
          <button
            className="button secondary"
            onClick={() => p.open({ type: 'priceHistory', data: o })}
          >
            {t('История стоимости', 'Price history')}
          </button>
        </div>
        {canEdit && (
          <div className="detail-actions">
            <button
              className="button secondary"
              onClick={() => p.open({ type: 'editObligation', data: o })}
            >
              {t('Изменить обязательство', 'Edit obligation')}
            </button>
            <button
              className="button secondary"
              onClick={() => p.open({ type: 'scheduleObligation', data: o })}
            >
              {t('Даты и график', 'Dates and schedule')}
            </button>
            {period && !period.amountConfirmed && (
              <button
                className="button secondary"
                onClick={() => p.open({ type: 'confirmAmount', data: period })}
              >
                {t('Подтвердить сумму', 'Confirm amount')}
              </button>
            )}
            <button
              className="button secondary"
              onClick={() =>
                p.open({ type: 'billingRule', data: { obligation: o, period } })
              }
            >
              {t('Изменить стоимость', 'Change price')}
            </button>
            {period && (
              <button
                className="button secondary"
                onClick={() => p.open({ type: 'waive', data: period })}
              >
                {t('Пропустить начисление', 'Waive period')}
              </button>
            )}
            {p.canDelete && (
              <button
                className="text-button danger-text"
                onClick={() => p.open({ type: 'archive', data: o })}
              >
                {t('Архивировать обязательство', 'Archive obligation')}
              </button>
            )}
            {p.canDeleteFull && (
              <button
                className="text-button danger-text"
                onClick={() => p.open({ type: 'deleteObligation', data: o })}
              >
                {t('Удалить обязательство целиком', 'Delete entire obligation')}
              </button>
            )}
          </div>
        )}
      </>
    );
  }
  if (
    modal.type === 'confirmAmount' ||
    modal.type === 'waive' ||
    modal.type === 'archive'
  )
    return (
      <>
        {title(
          modal.type === 'archive'
            ? t('Архивировать обязательство?', 'Archive obligation?')
            : modal.type === 'waive'
              ? t('Пропустить начисление?', 'Waive this period?')
              : t('Подтвердить сумму', 'Confirm amount'),
          modal.type === 'archive'
            ? t(
                'История сохранится. Новые начисления после выбранной даты создаваться не будут. Это не отменяет услугу у поставщика.',
                'History is retained. New periods stop after the selected date. This does not cancel the service with its provider.',
              )
            : undefined,
        )}
        <form
          onSubmit={catchForm((f) => {
            const commands: Command[] = [...p.periodCommands()];
            if (modal.type === 'archive')
              commands.push({
                type: 'ArchiveObligation',
                payload: {
                  obligationId: modal.data.id,
                  activeTo: String(f.get('date')),
                },
              });
            else if (modal.type === 'waive')
              commands.push({
                type: 'WaivePeriod',
                payload: {
                  periodId: modal.data.id,
                  reason: String(f.get('reason')),
                },
              });
            else
              commands.push({
                type: 'ConfirmPeriodAmount',
                payload: {
                  periodId: modal.data.id,
                  amount: parseMoney(
                    String(f.get('amount')),
                    state.rules.find(
                      (rule) => rule.id === modal.data.ruleVersionId,
                    )?.currency ?? state.household.currency,
                  ),
                },
              });
            void submit(
              commands,
              t('Корректировка начисления', 'Billing adjustment'),
            );
          })}
        >
          {modal.type === 'archive' ? (
            <Field label={t('Дата окончания', 'End date')}>
              <input name="date" type="date" defaultValue={today} required />
            </Field>
          ) : modal.type === 'waive' ? (
            <Field label={t('Причина', 'Reason')}>
              <textarea name="reason" required minLength={3} />
            </Field>
          ) : (
            <Field label={t('Точная сумма', 'Confirmed amount')}>
              <input
                name="amount"
                inputMode="decimal"
                required
                defaultValue={moneyInputValue(
                  modal.data.expectedAmount || 0,
                  state.rules.find(
                    (rule) => rule.id === modal.data.ruleVersionId,
                  )?.currency ?? state.household.currency,
                )}
              />
            </Field>
          )}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={close}>
              {t('Отмена', 'Cancel')}
            </button>
            <button className="button primary" disabled={busy}>
              {t('Подтвердить', 'Confirm')}
            </button>
          </div>
        </form>
      </>
    );
  if (modal.type === 'paymentDetail') {
    const payment = modal.data as Payment,
      allocations = state.allocations.filter(
        (a) => a.paymentId === payment.id && !a.reversedBy,
      ),
      refunds = state.refunds.filter((r) => r.originalPaymentId === payment.id);
    return (
      <>
        {title(
          payment.descriptor || t('Платёж', 'Payment'),
          date(payment.paidAt),
        )}
        <div className="detail-amount">
          <strong>{money(paymentBaseAmount(payment))}</strong>
          <span className="status green">{t('Записан', 'Recorded')}</span>
        </div>
        {canEdit && (
          <MatchSuggestions
            state={state}
            periods={periods}
            payment={payment}
            today={today}
            t={t}
            money={money}
            selected={selected}
            choose={setSelected}
          />
        )}
        <h3>{t('Распределения', 'Allocations')}</h3>
        {allocations.map((a) => {
          const period = state.periods.find((v) => v.id === a.billingPeriodId);
          return (
            <div className="simple-row" key={a.id}>
              <span className="grow">
                {
                  state.obligations.find((o) => o.id === period?.obligationId)
                    ?.title
                }{' '}
                · {period && date(period.dueDate)}
              </span>
              <strong>{money(a.amount)}</strong>
            </div>
          );
        })}
        <p className="muted">
          {t('Доступно для распределения', 'Available to allocate')}:{' '}
          {money(
            paymentBaseAmount(payment) -
              allocations.reduce((s, a) => s + a.amount, 0) -
              refunds.reduce((s, r) => s + (r.baseAmount ?? r.amount), 0),
          )}
        </p>
        {canEdit && (
          <form
            onSubmit={catchForm(
              (f) =>
                void submit(
                  [
                    ...p.periodCommands(),
                    {
                      type: 'AllocatePayment',
                      payload: {
                        paymentId: payment.id,
                        allocations: [
                          {
                            id: id(),
                            billingPeriodId: String(f.get('period')),
                            amount: parseMoney(
                              String(f.get('amount')),
                              state.household.currency,
                            ),
                          },
                        ],
                      },
                    },
                  ],
                  t('Распределение платежа', 'Payment allocation'),
                ),
            )}
          >
            <div className="form-grid">
              <Field label={t('Начисление', 'Billing period')}>
                <select
                  name="period"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  required
                >
                  <option value="">
                    {t('Выберите начисление', 'Choose a billing period')}
                  </option>
                  {periods.map((v) => (
                    <option key={v.id} value={v.id}>
                      {
                        state.obligations.find((o) => o.id === v.obligationId)
                          ?.title
                      }{' '}
                      · {date(v.dueDate)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('Сумма', 'Amount')}>
                <input name="amount" inputMode="decimal" required />
              </Field>
            </div>
            <button
              className="button primary"
              disabled={busy || !periods.length}
            >
              {t('Распределить', 'Allocate')}
            </button>
            {p.canDelete && (
              <button
                type="button"
                className="text-button danger-text"
                onClick={() => p.open({ type: 'refund', data: payment })}
              >
                {t('Записать возврат', 'Record refund')}
              </button>
            )}
          </form>
        )}
        {refunds.map((r) => (
          <div className="simple-row" key={r.id}>
            <span className="grow">
              {t('Возврат', 'Refund')} · {r.reason}
            </span>
            <strong>−{formatMoney(r.amount, payment.currency)}</strong>
          </div>
        ))}
      </>
    );
  }
  if (modal.type === 'refund')
    return (
      <>
        {title(
          t('Возврат платежа', 'Payment refund'),
          t(
            'Исходный платёж останется в истории. Выберите распределения, которые нужно отменить, чтобы освободить сумму возврата.',
            'The original payment stays in history. Select allocations to reverse and free enough money for the refund.',
          ),
        )}
        <form
          onSubmit={catchForm(
            (f) =>
              void submit(
                [
                  {
                    type: 'RefundPayment',
                    payload: {
                      refund: {
                        id: id(),
                        originalPaymentId: modal.data.id,
                        paidAt: String(f.get('date')),
                        amount: parseMoney(
                          String(f.get('amount')),
                          modal.data.currency,
                        ),
                        reason: String(f.get('reason')),
                      },
                      reverseAllocationIds: f.getAll('reverse').map(String),
                    },
                  },
                ],
                t('Возврат', 'Refund'),
              ),
          )}
        >
          <div className="form-grid">
            <Field
              label={`${t('Сумма возврата', 'Refund amount')}, ${modal.data.currency}`}
            >
              <input name="amount" inputMode="decimal" required />
            </Field>
            <Field label={t('Дата', 'Date')}>
              <input name="date" type="date" defaultValue={today} required />
            </Field>
          </div>
          <Field label={t('Причина', 'Reason')}>
            <input name="reason" required />
          </Field>
          {state.allocations
            .filter((a) => a.paymentId === modal.data.id && !a.reversedBy)
            .map((a) => (
              <label className="checkbox-row" key={a.id}>
                <input type="checkbox" name="reverse" value={a.id} />
                {t('Отменить распределение', 'Reverse allocation')}{' '}
                {money(a.amount)}
              </label>
            ))}
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={close}>
              {t('Отмена', 'Cancel')}
            </button>
            <button className="button primary" disabled={busy}>
              {t('Подтвердить возврат', 'Confirm refund')}
            </button>
          </div>
        </form>
      </>
    );
  if (modal.type === 'drafts')
    return (
      <>
        {title(
          t('Черновики и операции', 'Drafts & operations'),
          t(
            'Обычные изменения сохраняются сразу. Запросы с потерянным ответом повторяются автоматически без дублей. Отклонённые и офлайн-черновики нужно проверить и отправить кнопкой ниже; они пока не входят в суммы и доступны только на этом устройстве.',
            'Normal changes save immediately. Requests with a lost response retry automatically without duplicates. Rejected and offline drafts require review and sending below; they are excluded from totals and stay on this device.',
          ),
        )}
        {p.drafts.map((d) => (
          <div className="draft-card" key={d.id}>
            <div>
              <strong>{d.label}</strong>
              {d.error && <p className="notice danger">{d.error}</p>}
              <small>
                {new Date(d.createdAt).toLocaleString()} ·{' '}
                {d.status === 'pending'
                  ? t('Исход операции неизвестен', 'Operation outcome pending')
                  : t('Локальный черновик', 'Local draft')}
              </small>
            </div>
            <details>
              <summary>{t('Посмотреть изменения', 'Review changes')}</summary>
              <pre>{JSON.stringify(d.commands, null, 2)}</pre>
            </details>
            <div className="draft-actions">
              {d.operationId ? (
                <button
                  className="button secondary"
                  onClick={() => void p.checkDraft(d)}
                >
                  {t('Проверить статус', 'Check status')}
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void submit(d.commands, d.label, {
                      ...d,
                      expectedRevision: state.revision,
                    })
                  }
                >
                  {t(
                    'Проверено — отправить на сервер',
                    'Reviewed — send to server',
                  )}
                </button>
              )}
              {d.operationId && d.envelope && d.status !== 'blocked' && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void submit(d.commands, d.label, d)}
                >
                  {t('Повторить тот же запрос', 'Retry same request')}
                </button>
              )}
              {!d.operationId && (
                <button
                  className="text-button danger-text"
                  onClick={() =>
                    void db.drafts.delete(d.id).then(p.refreshDrafts)
                  }
                >
                  {t('Удалить', 'Delete')}
                </button>
              )}
            </div>
          </div>
        ))}
      </>
    );
  if (modal.type === 'takeover')
    return (
      <>
        {title(
          t('Завершить другие сессии?', 'End other sessions?'),
          t(
            'Другие устройства потеряют доступ до нового входа через Google. Несохранённые черновики останутся на устройствах.',
            'Other devices must sign in with Google again. Unsent drafts remain on their devices.',
          ),
        )}
        <div className="modal-actions">
          <button className="button secondary" onClick={close}>
            {t('Отмена', 'Cancel')}
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void api('/admin/takeover', { editorInstanceId })
                .then(() => {
                  p.setLease(null);
                  p.setToast(
                    t('Другие сессии завершены', 'Other sessions ended'),
                  );
                  close();
                })
                .catch(p.handleError)
            }
          >
            {t('Завершить другие сессии', 'End other sessions')}
          </button>
        </div>
      </>
    );
  if (modal.type === 'reminders')
    return (
      <>
        {title(
          t('Ближайшие заботы', 'Coming up'),
          t(
            'Напоминания обновляются, пока приложение открыто.',
            'Reminders update while the application is open.',
          ),
        )}
        {periods
          .filter((v) => getPeriodStatus(state, v, today).needsAction)
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .map((v) => (
            <button
              className="upcoming-item"
              key={v.id}
              onClick={() =>
                p.open({
                  type: 'detail',
                  data: {
                    period: v,
                    obligation: state.obligations.find(
                      (o) => o.id === v.obligationId,
                    ),
                  },
                })
              }
            >
              <span className="date-tile">
                <strong>{Number(v.dueDate.slice(8))}</strong>
                <small>{date(v.dueDate).split(' ').slice(1).join(' ')}</small>
              </span>
              <span className="grow">
                <strong>
                  {
                    state.obligations.find((o) => o.id === v.obligationId)
                      ?.title
                  }
                </strong>
                {p.statusBadge(v)}
              </span>
              <ChevronRight size={16} />
            </button>
          ))}
        {!periods.some((v) => getPeriodStatus(state, v, today).needsAction) && (
          <div className="empty-state">
            <CheckCheck size={35} />
            <h3>{t('Всё в порядке', 'All in order')}</h3>
            <p>
              {t(
                'В выбранном месяце нет открытых начислений.',
                'No open bills in the selected month.',
              )}
            </p>
          </div>
        )}
      </>
    );
  if (modal.type === 'connection')
    return (
      <>
        {title(t('Где живут ваши данные', 'Where your data lives'))}
        <span className="large-icon">
          <Cloud size={28} />
        </span>
        <p>
          {t(
            'Семейные устройства обращаются к единому серверу. Он проверяет права и сохраняет изменения в базе данных. Только подтверждённые изменения входят в общие суммы.',
            'Family devices use one server. It verifies permissions and commits changes to the database. Only confirmed changes are included in shared totals.',
          )}
        </p>
      </>
    );
  return (
    <>
      {title(
        t('Порядок начинается с малого', 'A little order goes a long way'),
      )}
      <div className="help-step">
        <b>1</b>
        <div>
          <h3>{t('Добавьте обязательства', 'Add your obligations')}</h3>
          <p>
            {t(
              'Укажите сумму, график и ответственного. Домовой рассчитает начисления.',
              'Choose an amount, schedule and owner. Domovoy generates the billing periods.',
            )}
          </p>
        </div>
      </div>
      <div className="help-step">
        <b>2</b>
        <div>
          <h3>{t('Записывайте оплату', 'Record payments')}</h3>
          <p>
            {t(
              'Распределяйте платежи на начисления — полностью или частями.',
              'Allocate payments to bills, in full or in parts.',
            )}
          </p>
        </div>
      </div>
      <div className="help-step">
        <b>3</b>
        <div>
          <h3>{t('Заглядывайте в обзор', 'Check your overview')}</h3>
          <p>
            {t(
              'Смотрите, что оплачено и что ещё ждёт внимания. Статусы основаны на распределениях.',
              'See what is paid and what needs attention. Statuses are based on payment allocations.',
            )}
          </p>
        </div>
      </div>
      <button className="button primary full" onClick={close}>
        {t('Всё понятно', 'Got it')}
        <Check size={17} />
      </button>
    </>
  );
}
