import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError("");
    setBusy(true);
    try {
      await login(form.get("email"), form.get("password"));
      navigate(next, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h1>Log in</h1>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
      <p className="muted small">
        New here? <Link to={`/register?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </p>
    </form>
  );
}
