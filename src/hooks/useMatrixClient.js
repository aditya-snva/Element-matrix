import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClientEvent, RoomEvent, MatrixEventEvent, MsgType,
  passwordLogin, buildClient, initCrypto, loadSavedSession, clearSavedSession,
  describeError, classifyEvent, logDecryptionFailure,
} from "../services/matrixClient.js";

export function useMatrixClient() {
  const clientRef = useRef(null);
  const [phase, setPhase] = useState("idle"); // idle | logging-in | crypto | syncing | ready | error
  const [status, setStatus] = useState("Not connected");
  const [syncState, setSyncState] = useState(null);
  const [cryptoStatus, setCryptoStatus] = useState("not initialised");
  const [session, setSession] = useState(null); // never contains password; token only in memory/sessionStorage
  const [loginError, setLoginError] = useState(null);
  const [errors, setErrors] = useState([]);
  const [version, setVersion] = useState(0); // bump to re-render on SDK events
  const loggedFailures = useRef(new Set());

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const pushError = useCallback((text) => {
    console.error("[MCT]", text);
    setErrors((e) => [{ at: new Date().toISOString(), text }, ...e].slice(0, 20));
  }, []);

  const stop = useCallback(() => {
    const c = clientRef.current;
    if (c) { c.removeAllListeners(); c.stopClient(); }
    clientRef.current = null;
  }, []);

  const startWithSession = useCallback(async (s) => {
    stop();
    setSession({ baseUrl: s.baseUrl, userId: s.userId, deviceId: s.deviceId });
    const client = buildClient(s);
    clientRef.current = client;

    setPhase("crypto"); setStatus("Initialising end-to-end encryption…"); setCryptoStatus("initialising");
    try {
      await initCrypto(client, s.deviceId);
      setCryptoStatus("ready (Rust crypto)");
    } catch (err) {
      const text = describeError(err, "crypto");
      setCryptoStatus("FAILED: " + text);
      setPhase("error"); setLoginError("Crypto initialisation failed — login is NOT complete. " + text);
      pushError("Crypto init: " + text);
      stop();
      return;
    }

    client.on(ClientEvent.Sync, (state, _prev, data) => {
      setSyncState(state);
      if (state === "PREPARED") { setPhase("ready"); setStatus("Connected"); }
      else if (state === "SYNCING") setStatus("Connected");
      else if (state === "RECONNECTING") setStatus("Reconnecting… (network issue)");
      else if (state === "ERROR") {
        setStatus("Sync error — retrying");
        const e = data?.error;
        if (e?.errcode === "M_UNKNOWN_TOKEN") {
          pushError("Session expired or logged out elsewhere (M_UNKNOWN_TOKEN). Please log in again.");
          clearSavedSession();
        } else pushError("Sync failed: " + describeError(e || "unknown", "sync"));
      } else if (state === "STOPPED") setStatus("Stopped");
      bump();
    });
    client.on(RoomEvent.Timeline, () => bump());
    client.on(RoomEvent.Name, () => bump());
    client.on(RoomEvent.Receipt, () => bump());
    client.on(RoomEvent.LocalEchoUpdated, () => bump());
    client.on(RoomEvent.MyMembership, () => bump());
    client.on(MatrixEventEvent.Decrypted, (ev) => {
      if (ev.isDecryptionFailure() && !loggedFailures.current.has(ev.getId())) {
        loggedFailures.current.add(ev.getId());
        logDecryptionFailure(ev);
      }
      bump();
    });

    setPhase("syncing"); setStatus("Starting sync…");
    try {
      await client.startClient({ initialSyncLimit: 30, lazyLoadMembers: true });
    } catch (err) {
      const text = describeError(err, "sync");
      setPhase("error"); setLoginError("Failed to start sync: " + text); pushError(text);
    }
  }, [bump, pushError, stop]);

  const login = useCallback(async (homeserver, username, password) => {
    setLoginError(null); setPhase("logging-in"); setStatus("Logging in…");
    try {
      const s = await passwordLogin(homeserver, username, password);
      await startWithSession(s);
    } catch (err) {
      const text = describeError(err, "login");
      setPhase("error"); setStatus("Not connected"); setLoginError(text); pushError("Login: " + text);
    }
  }, [startWithSession, pushError]);

  const logout = useCallback(async () => {
    const c = clientRef.current;
    try { await c?.logout(true); } catch (e) { console.warn("[MCT] logout error", e?.message); }
    stop(); clearSavedSession();
    setSession(null); setPhase("idle"); setStatus("Not connected"); setSyncState(null); setCryptoStatus("not initialised");
  }, [stop]);

  // Resume an existing session in this tab (keeps the same device + crypto store).
  useEffect(() => {
    const s = loadSavedSession();
    if (s) startWithSession(s);
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendText = useCallback(async (roomId, body) => {
    const c = clientRef.current;
    if (!c) throw new Error("Not connected");
    try {
      // SDK room-send API; encrypts automatically in encrypted rooms.
      await c.sendMessage(roomId, { msgtype: MsgType.Text, body });
    } catch (err) {
      const text = describeError(err, "send");
      pushError("Send failed: " + text);
      throw new Error(text);
    }
  }, [pushError]);

  const loadOlder = useCallback(async (roomId) => {
    const c = clientRef.current;
    const room = c?.getRoom(roomId);
    if (!room) return false;
    try {
      await c.scrollback(room, 30);
      bump();
      return !!room.oldState.paginationToken;
    } catch (err) {
      pushError("Load history: " + describeError(err, "history"));
      return true;
    }
  }, [bump, pushError]);

  return {
    client: clientRef.current, phase, status, syncState, cryptoStatus, session,
    loginError, errors, version, login, logout, sendText, loadOlder, pushError, classifyEvent, refresh: bump,
  };
}
