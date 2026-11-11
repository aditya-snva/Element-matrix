import React from "react";

/** Shown when another tab is running this session (only one tab may run a Matrix device). */
export default function OpenElsewhere({ onContinue, busy, error }) {
  return (
    <div className="login-wrap">
      <div className="card login" role="alertdialog" aria-labelledby="elsewhere-title">
        <h2 id="elsewhere-title">Open in another window</h2>
        <p className="muted">
          Matrix Chat Tester is open in another window. Click "Continue" to use it here and
          disconnect the other window.
        </p>
        <button className="btn primary" onClick={onContinue} disabled={busy}>
          {busy ? <><span className="spinner" /> Disconnecting the other window…</> : "Continue"}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
