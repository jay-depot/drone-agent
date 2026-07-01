import {
  useState,
  useCallback,
  createContext,
  useContext,
  type ReactNode,
} from 'react';

const TOKEN_STORAGE_KEY = 'drone-coordinator-web-token';

interface AuthContextValue {
  token: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
  isAuthenticated: boolean;
  /** Call when a fetch returns 401 — sets authenticated to false */
  handleUnauthorized: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(getStoredToken);
  const [isAuthenticated, setIsAuthenticated] = useState(true);

  const setToken = useCallback((newToken: string) => {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, newToken);
    } catch {
      // localStorage may be unavailable
    }
    setTokenState(newToken);
    setIsAuthenticated(true);
  }, []);

  const clearToken = useCallback(() => {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // localStorage may be unavailable
    }
    setTokenState(null);
    setIsAuthenticated(false);
  }, []);

  const handleUnauthorized = useCallback(() => {
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        token,
        setToken,
        clearToken,
        isAuthenticated,
        handleUnauthorized,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

/**
 * Wrapper around fetch that includes the auth token and handles 401 responses.
 */
export function useAuthenticatedFetch() {
  const { token, handleUnauthorized } = useAuth();

  return useCallback(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }

      const response = await fetch(url, {
        ...init,
        headers,
      });

      if (response.status === 401) {
        handleUnauthorized();
      }

      return response;
    },
    [token, handleUnauthorized]
  );
}
