import * as sdk from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/index.js";
import { createRecoveryCallbacks, restoreWithDecodedRecoveryKey, messageState } from "./messageRecovery.js";

export const DEFAULT_HOMESERVER =
  import.meta.env.VITE_DEFAULT_HOMESERVER || "https://matrix.snva.co.in";

const SESSION_KEY = "mct.session"; // sessionStorage only: cleared when the tab closes

export const { ClientEvent, RoomEvent, MatrixEventEvent, EventType, MsgType } = sdk;

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

export async function passwordLogin(homeserver, username, password) {
  const baseUrl = normalizeHomeserver(homeserver);
  const temp = sdk.createClient({ baseUrl });
  const res = await temp.loginRequest({
    type: "m.login.password",
    identifier: identifierFor(username),
    password,
    initial_device_display_name: "Matrix Chat Tester (web)",
  });
  temp.stopClient();
  const session = {
    baseUrl: res.well_known?.["m.homeserver"]?.base_url?.replace(/\/+$/, "") || baseUrl,
    userId: res.user_id,
    deviceId: res.device_id,
    accessToken: res.access_token,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
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
  await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: `mct-${deviceId}` });
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("initRustCrypto() completed but getCrypto() returned nothing.");
  return crypto;
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
