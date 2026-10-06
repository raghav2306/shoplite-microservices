import { useState } from "react";
import { useAuth } from "../auth";

export default function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError("");
    setBusy(true);
    try {
      await login(form.get("email"), form.get("password"));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="container login-screen">
      <form className="card form" onSubmit={submit}>
        <h1>
          ShopLite <span className="admin-tag">Admin</span>
        </h1>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
