import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { registerPush, unregisterPush } from './push';
import { MODE, api, loadToken, setToken, setUnauthorizedHandler, type User } from './api';

type Ctx = { user: User | null; loading: boolean; signIn: (token: string, user: User) => Promise<void>; signOut: () => Promise<void> };
const AuthCtx = createContext<Ctx>(null as unknown as Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    loadToken().then(t => (t ? api<User>('GET', '/me').then(setUser).catch(() => {}) : null)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (user && MODE === 'server') registerPush(); }, [user]);
  const signIn = async (t: string, u: User) => { await setToken(t); setUser(u); };
  const signOut = async () => { if (MODE === 'server') await unregisterPush(); await setToken(null); setUser(null); };
  return <AuthCtx.Provider value={{ user, loading, signIn, signOut }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
export const useUserId = () => useAuth().user?.id ?? '';
