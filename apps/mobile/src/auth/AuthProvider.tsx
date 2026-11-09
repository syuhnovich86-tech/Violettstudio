import type { PropsWithChildren } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { ApiError, login as apiLogin, logout as apiLogout, restoreSession, type ApiUser } from '../api/client';

type AuthState = {
  user: ApiUser | null;
  loading: boolean;
  signIn: (login: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void restoreSession()
      .then((session) => setUser(session.user))
      .catch((error) => {
        if (!(error instanceof ApiError && error.status === 401)) console.warn('Не удалось восстановить серверную сессию', error);
      })
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthState>(() => ({
    user,
    loading,
    signIn: async (login, password) => {
      const session = await apiLogin(login, password);
      setUser(session.user);
    },
    signOut: async () => {
      if (Platform.OS === 'android' && user) {
        const push = await import('../notifications/androidPush');
        await push.disableAndroidPush().catch(() => undefined);
        const backup = await import('../media/androidBackup');
        await backup.pauseAndroidBackup(user.id).catch(() => undefined);
      }
      if (Platform.OS === 'ios' && user) {
        const backup = await import('../media/iphoneBackup');
        await backup.pauseIphoneBackup(user.id).catch(() => undefined);
      }
      await apiLogout();
      setUser(null);
    },
    refreshUser: async () => {
      const session = await restoreSession();
      setUser(session.user);
    },
  }), [loading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth должен использоваться внутри AuthProvider');
  return value;
}
