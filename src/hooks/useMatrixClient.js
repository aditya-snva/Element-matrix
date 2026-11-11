import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClientEvent, RoomEvent, MatrixEventEvent, MsgType, HttpApiEvent,
  passwordLogin, buildClient, initCrypto, loadSavedSession, clearSavedSession, wipeDeviceStores,
  forgetDevice, lockDevice, unlockDevice,
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

  /** Stop the current client. By default also releases this tab's lock on its device. */
  const stop = useCallback(({ release = true } = {}) => {
    const c = clientRef.current;
    if (c) {
      c.removeAllListeners(); c.stopClient();
      if (release) unlockDevice(c.getDeviceId());
    }
    clientRef.current = null;
  }, []);

  /**
   * Tear down a finished device: stop the client, forget the token and the remembered
   * device ID, optionally log it out on the server, delete its crypto store and return
   * to the login screen. Only the first call for the current client does anything.
   */
  const endSession = useCallback(async (client, { reason = null, serverLogout = false } = {}) => {
    if (!client || clientRef.current !== client) return;
    const deviceId = client.getDeviceId();
    forgetDevice(deviceId);
    stop({ release: false }); // keep the device lock until its store is deleted
    clearSavedSession();
    setSession(null); setPhase("idle"); setStatus("Not connected"); setSyncState(null);
    setCryptoStatus("not initialised"); setLoginError(reason);
    if (serverLogout) {
      // Even if this fails (offline), the token is dropped locally, so the store is useless.
      try { await client.logout(); } catch (e) { console.warn("[MCT] logout error", e?.message); }
    }
    await wipeDeviceStores(client, deviceId); // stopClient() closed the crypto DB, so it can be deleted
    unlockDevice(deviceId);
  }, [stop]);

  /** `fresh` = straight after a password login (vs. resuming the tab's saved session). */
  const startWithSession = useCallback(async (s, { fresh = false } = {}) => {
    stop();
    if (!(await lockDevice(s.deviceId))) {
      // Typically a duplicated tab: it copied sessionStorage, but the original tab is
      // using this device's crypto store. Sharing it would corrupt the store.
      clearSavedSession();
      setPhase("error"); setStatus("Not connected");
      setLoginError("This session is already open in another tab. Use that tab, or log in here to get a separate session.");
      return;
    }
    setSession({ baseUrl: s.baseUrl, userId: s.userId, deviceId: s.deviceId });
    const client = buildClient(s);
    clientRef.current = client;

    setPhase("crypto"); setStatus("Initialising end-to-end encryption…"); setCryptoStatus("initialising");
    try {
      await initCrypto(client, s.deviceId);
      setCryptoStatus("ready (Rust crypto)");
    } catch (err) {
      const text = describeError(err, "crypto");
      const reason = "Crypto initialisation failed — login is NOT complete. " + text;
      pushError("Crypto init: " + text);
      if (fresh) {
        // The device can't be used without crypto: remove it on the server (so it doesn't
        // linger as an unverified session in Element) and drop its local store.
        await endSession(client, { reason, serverLogout: true });
      } else {
        stop(); // resumed session: keep it, so a reload can retry
      }
      setCryptoStatus("FAILED: " + text); setPhase("error"); setLoginError(reason);
      return;
    }

    client.on(ClientEvent.Sync, (state, _prev, data) => {
      setSyncState(state);
      if (state === "PREPARED") { setPhase("ready"); setStatus("Connected"); }
      else if (state === "SYNCING") setStatus("Connected");
      else if (state === "RECONNECTING") setStatus("Reconnecting… (network issue)");
      else if (state === "ERROR") {
        const e = data?.error;
        if (e?.errcode === "M_UNKNOWN_TOKEN") { onLoggedOut(); return; }
        setStatus("Sync error — retrying");
        pushError("Sync failed: " + describeError(e || "unknown", "sync"));
      } else if (state === "STOPPED") setStatus("Stopped");
      bump();
    });
    // Emitted by the SDK on any request rejected with M_UNKNOWN_TOKEN (token revoked,
    // device deleted, or logged out elsewhere). The session cannot recover from this.
    const onLoggedOut = () => {
      const text = "Session expired or logged out elsewhere (M_UNKNOWN_TOKEN). Please log in again.";
      pushError(text);
      endSession(client, { reason: text });
    };
    client.on(HttpApiEvent.SessionLoggedOut, onLoggedOut);
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
      if (clientRef.current !== client) return; // session already ended (e.g. token revoked)
      const text = describeError(err, "sync");
      setPhase("error"); setLoginError("Failed to start sync: " + text); pushError(text);
    }
  }, [bump, pushError, stop, endSession]);

  const login = useCallback(async (homeserver, username, password) => {
    setLoginError(null); setPhase("logging-in"); setStatus("Logging in…");
    try {
      const s = await passwordLogin(homeserver, username, password);
      await startWithSession(s, { fresh: true });
    } catch (err) {
      const text = describeError(err, "login");
      setPhase("error"); setStatus("Not connected"); setLoginError(text); pushError("Login: " + text);
    }
  }, [startWithSession, pushError]);

  const logout = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    await endSession(c, { serverLogout: true });
  }, [endSession]);

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
