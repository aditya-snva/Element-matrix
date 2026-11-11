import * as sdk from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/index.js";
import { createRecoveryCallbacks, restoreWithDecodedRecoveryKey, messageState } from "./messageRecovery.js";

export const DEFAULT_HOMESERVER =
  import.meta.env.VITE_DEFAULT_HOMESERVER || "https://matrix.snva.co.in";

const SESSION_KEY = "mct.session"; // sessionStorage only: cleared when the tab closes

export const { ClientEvent, RoomEvent, MatrixEventEvent, EventType, MsgType, HttpApiEvent } = sdk;

/** IndexedDB prefix for this device's Rust crypto store. */
export const cryptoPrefixFor = (deviceId) => `mct-${deviceId}`;

export function normalizeHomeserver(url) {
  let u = (url || "").trim();
  if (!u) throw new Error("Homeserver URL is required.");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/+$/, "");
}

/** Translate SDK/network errors into actionable messages (never includes secrets). */
export function describeError(err, stage) {
  const msg = err?.message || String(err);
  const code = err?.errcode || err?.data?.errcode;
  if (code === "M_FORBIDDEN" && stage === "login") return "Invalid username or password (M_FORBIDDEN).";
  if (code === "M_USER_DEACTIVATED") return "This account has been deactivated.";
  if (code === "M_LIMIT_EXCEEDED") return "Rate limited by the homeserver. Wait a moment and retry.";
  if (code === "M_FORBIDDEN") return `Permission denied: ${msg}`;
  if (code) return `${code}: ${msg}`;
  if (/Incorrect response MIME type|application\/wasm/i.test(msg))
    return "WebAssembly MIME-type error: the server did not serve the crypto .wasm file as application/wasm. Run the app via START-APP.bat / `npm run dev`. Details: " + msg;
  if (/WebAssembly|wasm/i.test(msg)) return "WebAssembly crypto module failed to load: " + msg;
  if (/Failed to fetch|NetworkError|ConnectionError|ERR_NAME|ERR_CONNECTION/i.test(msg))
    return stage === "login"
      ? "Homeserver unreachable. Check the URL, your network, and that the server allows CORS. Details: " + msg
      : "Network error: " + msg;
  return msg;
}

/** Resolve the input to a localpart or full MXID identifier. */
function identifierFor(username) {
  const u = username.trim();
  return { type: "m.id.user", user: u };
}

// ---- Device reuse -------------------------------------------------------------
// Each /login normally creates a NEW device, so every closed tab used to leave an
// unverified session behind in Element. We remember the device ID (not a secret)
// per homeserver + username and log in to that same device next time, reusing its
// crypto store. The access token itself still lives only in sessionStorage.
const DEVICES_KEY = "mct.devices";

const slotFor = (baseUrl, username) => `${baseUrl}|${username.trim().toLowerCase()}`;

function readDevices() {
  try { return JSON.parse(localStorage.getItem(DEVICES_KEY) || "{}") || {}; } catch { return {}; }
}
function writeDevices(map) {
  try { localStorage.setItem(DEVICES_KEY, JSON.stringify(map)); } catch { /* storage unavailable */ }
}

/** Stop reusing this device (it was logged out, revoked, or its store is gone). */
export function forgetDevice(deviceId) {
  const map = readDevices();
  for (const [slot, d] of Object.entries(map)) if (d?.deviceId === deviceId) delete map[slot];
  writeDevices(map);
}

// One tab per device: two tabs must never open the same crypto store at once.
// A Web Lock is held for as long as this tab uses the device (released on stop or tab close).
const heldLocks = new Map(); // deviceId -> release()

/**
 * Take this tab's lock on a device. By default fails at once if another tab holds it;
 * with `waitMs` it waits up to that long for the other tab to release it (takeover).
 */
export async function lockDevice(deviceId, { waitMs = 0 } = {}) {
  if (heldLocks.has(deviceId)) return true;
  if (!navigator.locks) return true; // very old browser: no way to check
  const opts = waitMs > 0 ? { signal: AbortSignal.timeout(waitMs) } : { ifAvailable: true };
  return new Promise((resolve) => {
    navigator.locks.request(`mct-device-${deviceId}`, opts, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return new Promise((release) => heldLocks.set(deviceId, release));
    }).catch(() => resolve(false));
  });
}

export function unlockDevice(deviceId) {
  heldLocks.get(deviceId)?.();
  heldLocks.delete(deviceId);
}

/** True if the login landed on the remembered device AND the server still has its keys. */
async function reusedDeviceIsIntact(baseUrl, res, reuse) {
  if (res.user_id !== reuse.userId || res.device_id !== reuse.deviceId) return false;
  try {
    const temp = sdk.createClient({ baseUrl, accessToken: res.access_token, userId: res.user_id });
    const keys = await temp.downloadKeysForUsers([res.user_id]);
    return !!keys.device_keys?.[res.user_id]?.[res.device_id];
  } catch {
    return true; // can't tell (network): keep the device rather than throw it away
  }
}

/** Delete a device's crypto store without a running client (an unstarted client can clear stores). */
async function wipeStoreById(baseUrl, deviceId) {
  await wipeDeviceStores(sdk.createClient({ baseUrl }), deviceId);
}

async function revokeToken(baseUrl, accessToken) {
  try { await sdk.createClient({ baseUrl, accessToken }).logout(); } catch { /* best effort */ }
}

export async function passwordLogin(homeserver, username, password) {
  const baseUrl = normalizeHomeserver(homeserver);
  const slot = slotFor(baseUrl, username);
  const remembered = readDevices()[slot];
  // Reuse the previous device only if no other tab is currently using it.
  const reuse = remembered?.deviceId && (await lockDevice(remembered.deviceId)) ? remembered : null;

  const request = (deviceId) => {
    const temp = sdk.createClient({ baseUrl });
    return temp.loginRequest({
      type: "m.login.password",
      identifier: identifierFor(username),
      password,
      initial_device_display_name: "Matrix Chat Tester (web)",
      ...(deviceId ? { device_id: deviceId } : {}),
    });
  };

  let res;
  try {
    res = await request(reuse?.deviceId);
    if (reuse && !(await reusedDeviceIsIntact(baseUrl, res, reuse))) {
      // Either a different account (never attach another account's crypto store), or the
      // device was deleted (e.g. from Element) while this tab was closed: the server then
      // dropped its keys and the old store would not upload them again. Discard it and
      // start a clean device instead.
      await revokeToken(baseUrl, res.access_token);
      if (res.user_id === reuse.userId) await wipeStoreById(baseUrl, reuse.deviceId);
      forgetDevice(reuse.deviceId);
      unlockDevice(reuse.deviceId);
      res = await request(null);
    }
  } catch (err) {
    if (reuse) unlockDevice(reuse.deviceId);
    throw err;
  }
  if (reuse && res.device_id !== reuse.deviceId) unlockDevice(reuse.deviceId);

  writeDevices({ ...readDevices(), [slot]: { userId: res.user_id, deviceId: res.device_id } });
  const session = {
    baseUrl: res.well_known?.["m.homeserver"]?.base_url?.replace(/\/+$/, "") || baseUrl,
    userId: res.user_id,
    deviceId: res.device_id,
    accessToken: res.access_token,
  };
  saveSession(session);
  return session;
}

/** Keep the session for this tab only (sessionStorage is cleared when the tab closes). */
export function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSavedSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return s && s.accessToken && s.userId && s.deviceId ? s : null;
  } catch {
    return null;
  }
}

export function clearSavedSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function buildClient(session) {
  const client = sdk.createClient({
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
    timelineSupport: true,
    cryptoCallbacks: createRecoveryCallbacks(() => client),
  });
  return client;
}

/** Must run BEFORE startClient(). Uses IndexedDB, one store per device. */
export async function initCrypto(client, deviceId) {
  if (typeof WebAssembly === "undefined") throw new Error("This browser does not support WebAssembly.");
  await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: cryptoPrefixFor(deviceId) });
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("initRustCrypto() completed but getCrypto() returned nothing.");
  return crypto;
}

/**
 * Delete this device's crypto store from IndexedDB. Call only once the device is
 * finished (logged out / token revoked): its keys can never be used again.
 * The client must already be stopped (stopClient() closes the crypto DB).
 */
export async function wipeDeviceStores(client, deviceId) {
  if (!client || !deviceId) return;
  try {
    await client.clearStores({ cryptoDatabasePrefix: cryptoPrefixFor(deviceId) });
  } catch (err) {
    console.warn("[MCT] Could not delete crypto store", cryptoPrefixFor(deviceId), err?.message);
  }
}

/** Unlock Element secret storage, then restore the existing server message backup. */
export async function restoreFromRecoveryKey(client, recoveryKey, opts) {
  let key;
  try { key = decodeRecoveryKey(recoveryKey.trim()); }
  catch { throw new Error("Invalid Recovery Key format. Paste the complete Recovery Key from Element, not your password."); }
  return restoreWithDecodedRecoveryKey(client, key, opts);
}

/** Import an UNENCRYPTED JSON key export (array of exported room keys). */
export async function importKeysJson(client, json) {
  JSON.parse(json); // validate
  await client.getCrypto().importRoomKeysAsJson(json);
}

/**
 * Classifies an event into one of:
 *  "plain" (not encrypted), "decrypted", "waiting" (waiting for room key),
 *  "failed" (cannot be decrypted), "pending" (decryption in progress).
 */
export const classifyEvent = messageState;

/** Safe debug log for decryption failures (no keys, tokens or ciphertext). */
export function logDecryptionFailure(ev) {
  console.warn("[MCT] Unable to decrypt event", {
    eventId: ev.getId(),
    roomId: ev.getRoomId(),
    sender: ev.getSender(),
    sessionId: ev.getWireContent()?.session_id,
    algorithm: ev.getWireContent()?.algorithm,
    reason: ev.decryptionFailureReason,
  });
}

export function isDisplayable(ev) {
  if (ev.isState() || ev.isRedacted()) return false;
  if (ev.isEncrypted()) return true; // show with status even if undecryptable
  return ev.getType() === EventType.RoomMessage;
}

export function previewFor(ev) {
  if (!ev) return "";
  const s = classifyEvent(ev);
  if (s === "waiting") return "🔒 Waiting for room key";
  if (s === "failed") return "🔒 Unable to decrypt";
  if (s === "pending") return "🔒 Decrypting…";
  return ev.getContent()?.body || "";
}

export function latestDisplayable(room) {
  const evs = room.getLiveTimeline().getEvents();
  for (let i = evs.length - 1; i >= 0; i--) if (isDisplayable(evs[i])) return evs[i];
  return null;
}
