import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On page load, ask the backend whether the cookie is still a valid session.
  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function loginWithPassword(email, password) {
    const u = await api.loginWithPassword(email, password);
    setUser(u);
    return u;
  }

  async function loginWithGoogle(credential) {
    const u = await api.loginWithGoogle(credential);
    setUser(u);
    return u;
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginWithPassword, loginWithGoogle, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
