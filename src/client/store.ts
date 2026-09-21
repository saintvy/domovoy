import Dexie, { type Table } from 'dexie';
import {
  authHeaders,
  ensureFreshIdToken,
  isAuthenticated,
  rememberSession,
  runtimeConfig,
} from './auth';
import { type Command } from '../domain';

export interface User {
  id: string;
  name?: string;
  displayName?: string;
  login: string;
  role:
    'admin' | 'editor' | 'own_editor' | 'deleter' | 'observer' | 'participant';
  personId?: string;
  familyId?: string;
  mustChangePassword?: boolean;
}
export interface Lease {
  leaseId: string;
  fencingToken: number;
  expiresAt?: number;
  editorInstanceId?: string;
}
export interface Draft {
  id: string;
  userId: string;
  commands: Command[];
  label: string;
  createdAt: string;
  expectedRevision: number;
  operationId?: string;
  status?: string;
  envelope?: Record<string, unknown>;
  error?: string;
  familyId?: string;
}
class LocalDatabase extends Dexie {
  values!: Table<{ id: string; value: unknown }>;
  drafts!: Table<Draft>;
  constructor() {
    super('domovoy-client-v1');
    this.version(1).stores({ values: 'id', drafts: 'id,userId' });
    // Remove snapshots and drafts from the previous single-family/demo installation.
    this.version(2)
      .stores({ values: 'id', drafts: 'id,userId' })
      .upgrade(async (tx) => {
        await tx.table('values').clear();
        await tx.table('drafts').clear();
      });
  }
}
export const db = new LocalDatabase();
export const editorInstanceId = crypto.randomUUID();
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  if (!navigator.onLine)
    throw new ApiError('OFFLINE', 'Нет соединения с сервером.', 0);
  if (path === '/session' && !isAuthenticated())
    return { initialized: true, user: null, instanceId: location.origin } as T;
  await ensureFreshIdToken();
  let response: Response;
  const initialToken = authHeaders().Authorization?.slice(7);
  const send = () =>
    fetch(`${runtimeConfig().apiBaseUrl}${path}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      credentials: 'omit',
      signal: AbortSignal.timeout(25000),
      headers: {
        ...authHeaders(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    response = await send();
  } catch {
    throw new ApiError(
      'OFFLINE',
      'Нет соединения с сервером. Проверьте сеть.',
      0,
    );
  }
  let data: any = await response.json().catch(() => null);
  const authCode = data?.error?.code ?? data?.code;
  if (
    response.status === 401 &&
    (!authCode || authCode === 'AUTH_REQUIRED') &&
    initialToken
  ) {
    if (await ensureFreshIdToken(true, initialToken)) {
      response = await send();
      data = await response.json().catch(() => null);
    }
  }
  if (!response.ok || data === null)
    throw new ApiError(
      data?.error?.code ||
        data?.code ||
        (response.status === 401 ? 'AUTH_REQUIRED' : 'UNAVAILABLE'),
      data?.error?.message ||
        data?.message ||
        'Сервер приложения пока недоступен.',
      response.status,
    );
  if (typeof data.sessionToken === 'string') rememberSession(data.sessionToken);
  return data as T;
}
export function download(
  name: string,
  contents: string,
  type = 'application/json',
) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
