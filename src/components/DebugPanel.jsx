import React, { useEffect, useRef, useState } from "react";
import { restoreFromRecoveryKey, importKeysJson, describeError } from "../services/matrixClient.js";
import { getMessageBackupStatus } from "../services/messageRecovery.js";

export default function DebugPanel(p) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [keyJson, setKeyJson] = useState("");
  const [keyMsg, setKeyMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState("Not checked");
  const recoveryInput = useRef(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!p.recoveryRequest) return;
    setOpen(true);
    requestAnimationFrame(() => recoveryInput.current?.focus());
  }, [p.recoveryRequest]);

  useEffect(() => {
    let active = true;
    if (open && p.canRestore) {
      getMessageBackupStatus(p.client).then((s) => { if (active) setBackupStatus(s); })
        .catch(() => { if (active) setBackupStatus("Could not check backup"); });
    }
    return () => { active = false; };
  }, [open, p.canRestore, p.client]);

  // Diagnostic info: NO passwords, access tokens, recovery keys or session keys.
  const diag = {
    app: "Matrix Chat Tester",
    sdk: "matrix-js-sdk 45.0.0 (Rust crypto)",
    time: new Date().toISOString(),
    homeserver: p.homeserver || null,
    userId: p.userId || null,
    deviceId: p.deviceId || null,
    connection: p.status,
    syncState: p.syncState,
    crypto: p.cryptoStatus,
    messageBackup: backupStatus,
    selectedRoomId: p.roomId || null,
    selectedRoomEncrypted: p.roomEncrypted ?? null,
    messagesLoaded: p.msgCount,
    recentErrors: p.errors,
    userAgent: navigator.userAgent,
  };

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const restore = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setKeyMsg(null);
    const suppliedKey = recoveryKey;
    setRecoveryKey("");
    try {
      const r = await restoreFromRecoveryKey(p.client, suppliedKey, {
        progressCallback: (progress) => setKeyMsg(progress.stage === "fetch"
          ? "Downloading message keys…"
          : `Importing message keys… ${progress.successes ?? 0} imported`),
      });
      setBackupStatus(await getMessageBackupStatus(p.client));
      setKeyMsg(r.imported > 0
        ? `Restored ${r.imported} of ${r.total} keys. Messages with matching keys will update automatically; missing keys need a trusted device's room-key export.`
        : `No keys imported (${r.total} found in backup). Use a room-key export from a device that can read the missing messages.`);
      p.onRecovered?.();
    } catch (e) { const t = describeError(e, "keys"); setKeyMsg("Restore failed: " + t); p.pushError("Key restore: " + t); }
    finally { setRecoveryKey(""); setBusy(false); busyRef.current = false; }
  };

  const doImport = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setKeyMsg(null);
    try { await importKeysJson(p.client, keyJson); setKeyMsg("Room keys imported."); p.onRecovered?.(); }
    catch (e) { const t = describeError(e, "keys"); setKeyMsg("Import failed: " + t); p.pushError("Key import: " + t); }
    finally { setKeyJson(""); setBusy(false); busyRef.current = false; }
  };

  return (
    <div className="debug">
      <button className="debug-toggle" onClick={() => setOpen(!open)}>{open ? "▼" : "▶"} Debug panel</button>
      {open && (
        <div className="debug-body">
          <table><tbody>
            {[
              ["Homeserver", diag.homeserver], ["User ID", diag.userId], ["Device ID", diag.deviceId],
              ["Connection", diag.connection], ["Sync state", diag.syncState], ["Crypto", diag.crypto],
              ["Message backup", backupStatus],
              ["Selected room", diag.selectedRoomId], ["Room encrypted", String(diag.selectedRoomEncrypted)],
              ["Messages loaded", diag.messagesLoaded],
            ].map(([k, v]) => <tr key={k}><th>{k}</th><td>{v ?? "—"}</td></tr>)}
          </tbody></table>
          <div className="small"><b>Recent errors</b></div>
          {p.errors.length === 0 ? <div className="muted small">None</div> : (
            <ul className="errlist">{p.errors.map((e, i) => <li key={i}><span className="muted">{e.at}</span> {e.text}</li>)}</ul>
          )}
          <button className="btn ghost small" onClick={copy}>{copied ? "Copied!" : "Copy diagnostic info"}</button>

          {p.canRestore && (
            <div className="keys">
              <div className="small"><b>Restore historical message keys</b></div>
              <div className="row">
                <input ref={recoveryInput} aria-label="Recovery Key" type="password" placeholder="Element Recovery Key (Security Key)" value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)} autoComplete="off" disabled={busy} />
                <button className="btn ghost small" disabled={busy || !recoveryKey} onClick={restore}>Restore from backup</button>
              </div>
              <div className="row">
                <textarea rows={2} placeholder="Paste UNENCRYPTED room-key export JSON (array)" value={keyJson} onChange={(e) => setKeyJson(e.target.value)} />
                <button className="btn ghost small" disabled={busy || !keyJson} onClick={doImport}>Import keys</button>
              </div>
              {keyMsg && <div className="small" role="status">{keyMsg}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
