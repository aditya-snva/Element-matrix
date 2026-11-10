import React, { useState } from "react";
import { DEFAULT_HOMESERVER } from "../services/matrixClient.js";

export default function LoginForm({ onLogin, phase, status, error }) {
  const [hs, setHs] = useState(DEFAULT_HOMESERVER);
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const busy = ["logging-in", "crypto", "syncing"].includes(phase);

  const submit = (e) => {
    e.preventDefault();
    if (busy || !user || !pw) return;
    onLogin(hs, user, pw);
    setPw(""); // don't keep the password in state
  };

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h2>Sign in to Matrix</h2>
        <label>Homeserver URL
          <input value={hs} onChange={(e) => setHs(e.target.value)} disabled={busy} required />
        </label>
        <label>Username or Matrix ID
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="alice or @alice:matrix.snva.co.in" autoComplete="username" disabled={busy} required />
        </label>
        <label>Password
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" disabled={busy} required />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !user || !pw}>
          {busy ? <><span className="spinner" /> {status}</> : "Log in"}
        </button>
        <div className="muted small">Status: {status}</div>
        {error && <div className="error">{error}{phase === "error" && <div className="small">Fix the problem and press "Log in" to retry.</div>}</div>}
      </form>
    </div>
  );
}
