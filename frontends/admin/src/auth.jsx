import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  // Only admins may stay signed in; the gateway enforces this too.
  const loadUser = useCallback(async () => {
    try {
      const me = await api("/users/me");
      if (me.role !== "admin") throw new Error("This account doesn't have admin access");
      setUser(me);
    } catch (err) {
      setToken(null);
      setUser(null);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (getToken()) loadUser().catch(() => {});
  }, [loadUser]);

  const login = async (email, password) => {
    const { token } = await api("/users/login", { method: "POST", body: { email, password } });
    setToken(token);
    await loadUser();
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
