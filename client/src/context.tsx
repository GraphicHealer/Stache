import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { drainOutbox, outboxCount } from './outbox';

export interface AreaRef {
  id: string;
  name: string | null;
  thumb: string | null;
}

interface Toast {
  id: number;
  message: string;
  eventId?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
}

interface AppCtx {
  /** undefined = still checking, null = signed out. */
  user: User | null | undefined;
  setUser: (u: User | null) => void;
  signOut: () => Promise<void>;
  currentArea: AreaRef | null;
  setCurrentArea: (a: AreaRef | null) => void;
  /** A captured photo waiting for a destination scan (item-first flow). */
  stagedPhoto: Blob | null;
  setStagedPhoto: (b: Blob | null) => void;
  pending: number;
  refreshPending: () => Promise<void>;
  toast: (message: string, eventId?: string) => void;
}

const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

const LS_KEY = 'stash.currentArea';

export function AppProvider({ children }: { children: ReactNode }) {
  const [currentArea, setArea] = useState<AreaRef | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
    } catch {
      return null;
    }
  });
  const [stagedPhoto, setStagedPhoto] = useState<Blob | null>(null);
  const [pending, setPending] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const toastId = useRef(0);

  const signOut = useCallback(async () => {
    await api.post('/api/auth/sign-out').catch(() => {});
    setUser(null);
  }, []);

  // Session check on boot; any 401 elsewhere bounces back to login.
  useEffect(() => {
    api.get('/api/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
    const unauth = () => setUser(null);
    window.addEventListener('stash:unauth', unauth);
    return () => window.removeEventListener('stash:unauth', unauth);
  }, []);

  const setCurrentArea = useCallback((a: AreaRef | null) => {
    setArea(a);
    if (a) localStorage.setItem(LS_KEY, JSON.stringify(a));
    else localStorage.removeItem(LS_KEY);
  }, []);

  const refreshPending = useCallback(async () => {
    setPending(await outboxCount().catch(() => 0));
  }, []);

  const toast = useCallback((message: string, eventId?: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, eventId }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const undo = useCallback(
    async (t: Toast) => {
      if (!t.eventId) return;
      try {
        await api.post(`/api/events/${t.eventId}/undo`);
        setToasts((all) => all.filter((x) => x.id !== t.id));
        toast('Undone');
      } catch (e) {
        toast(`Undo failed: ${(e as Error).message}`);
      }
    },
    [toast],
  );

  // Drain the outbox on boot and whenever connectivity returns.
  useEffect(() => {
    const sync = () => drainOutbox().then(setPending).catch(() => {});
    sync();
    window.addEventListener('online', sync);
    const timer = setInterval(sync, 30_000);
    return () => {
      window.removeEventListener('online', sync);
      clearInterval(timer);
    };
  }, []);

  return (
    <Ctx.Provider
      value={{ user, setUser, signOut, currentArea, setCurrentArea, stagedPhoto, setStagedPhoto, pending, refreshPending, toast }}
    >
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.eventId && (
              <button className="toast-undo" onClick={() => undo(t)}>
                Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
