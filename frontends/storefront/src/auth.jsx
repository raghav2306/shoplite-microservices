import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  const loadUser = useCallback(async () => {
    try {
      setUser(await api("/users/me"));
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (getToken()) loadUser();
  }, [loadUser]);

  const login = async (email, password) => {
    const { token } = await api("/users/login", { method: "POST", body: { email, password } });
    setToken(token);
    await loadUser();
  };

  const register = async (name, email, password) => {
    await api("/users/register", { method: "POST", body: { name, email, password } });
    await login(email, password);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
