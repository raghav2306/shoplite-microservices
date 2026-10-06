import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";

export default function RegisterPage() {
  const { register } = useAuth();
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
      await register(form.get("name"), form.get("email"), form.get("password"));
      navigate(next, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h1>Create account</h1>
      <label>
        Name
        <input name="name" autoComplete="name" required />
      </label>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
      <p className="muted small">
        Already have an account? <Link to={`/login?next=${encodeURIComponent(next)}`}>Log in</Link>
      </p>
    </form>
  );
}
