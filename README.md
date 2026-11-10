# Matrix Chat Tester

Standalone React + Vite tool for testing Element/Matrix (`matrix-js-sdk` 45.0.0, Rust crypto) before CRM integration.
No custom backend: the browser talks directly to the homeserver (default `https://matrix.snva.co.in`).

## Run on Windows
1. Install Node.js 20 LTS or newer from https://nodejs.org/
2. Double-click `START-APP.bat`. It checks Node, runs `npm install` on first run, starts the dev server and opens http://localhost:5173.
3. Log in with your Matrix username (or full `@user:server` ID) and password.

Manual alternative: `npm install` then `npm run dev`.

## How it works
- Login: `loginRequest({ type: "m.login.password" })`, then a new client with the returned credentials.
- `initRustCrypto()` runs BEFORE `startClient()`. If crypto fails, login is reported as failed with the real error.
- Real-time: `ClientEvent.Sync`, `RoomEvent.Timeline`, `MatrixEventEvent.Decrypted` (no polling). The SDK reconnects on its own; the header shows RECONNECTING / ERROR.
- Sending: `client.sendMessage(roomId, { msgtype: "m.text", body })` (encrypted automatically in E2E rooms).
- History: `client.scrollback(room, 30)` via "Load older messages".
- Each message shows one of: Not encrypted, Decrypted, Waiting for room key, Unable to decrypt, Decrypting. Ciphertext is never shown.
- Decryption failures are logged in the console with room ID, sender, session ID and failure code only.

## Session and secrets
The access token lives only in `sessionStorage` (cleared when the tab closes), so a reload keeps the same device and crypto store. The password is never stored. Crypto keys are in IndexedDB, one store per device (`mct-<deviceId>`). Diagnostics never include passwords, tokens, recovery keys or room keys. The Recovery Key text is cleared when a restore starts; its decoded bytes are retained only for that restore and then wiped. The SDK stores the recovered **message-backup key** and imported room keys in its IndexedDB crypto store.

## WebAssembly
`vite.config.js` excludes `@matrix-org/matrix-sdk-crypto-wasm` from pre-bundling and forces `Content-Type: application/wasm` for `.wasm` files. If you host the built `dist/` elsewhere, that server must also serve `.wasm` as `application/wasm`.

## Old encrypted messages
Logging in creates a new device that has no keys for older messages.
`HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED` means the event **is encrypted** and a backup exists, but this device cannot yet unlock that backup. It does not mean the message is plaintext or that crypto failed to initialize.

1. Click **Restore old messages** on an affected message (or open Debug panel). Get your existing **Recovery Key / Security Key** from your trusted Element session under Settings -> Security & Privacy -> Secure Backup / Recovery (names vary by Element version). Paste it locally into the tester and click **Restore from backup**. Never send your key, password, or access token to anyone or paste it into chat.
2. The tester supplies the key through `cryptoCallbacks.getSecretStorageKey`, validates it with `secretStorage.checkKey`, and uses `loadSessionBackupPrivateKeyFromSecretStorage` to retrieve and validate the separate backup decryption key. It then calls `checkKeyBackupAndEnable` and `restoreKeyBackup`. It never creates, resets, or overwrites your server backup.
3. Matching room keys trigger the SDK's normal decryption retry and timeline updates. Restoring some keys does not prove all older messages can be read: sessions absent from the backup still require keys from an existing trusted device.
4. Key import: `importRoomKeysAsJson` accepts an unencrypted JSON key array. Element's passphrase-encrypted "Export E2E room keys" file is not decoded by this tool. Use a legitimate compatible JSON export locally or the recovery option above; never share the export.
5. New messages: other devices may share keys with this device. Some senders withhold keys from unverified devices (`MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE`); verify this device from Element.

Do not reset Secure Backup or clear site data as a first troubleshooting step. Keep the same browser and localhost port when reloading; closing the tab and signing in again creates a new device and may require recovery again.

## Recovery regression tests
Run `npm test` (Node.js 20+). Tests cover the separate secret-storage/backup keys, wrong-key rejection, missing backup, cleanup after failure, and plain versus encrypted event classification.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Invalid username or password | Check credentials (M_FORBIDDEN). |
| Homeserver unreachable | Check URL/network; server must allow CORS. |
| WebAssembly MIME-type error | Run via START-APP.bat / `npm run dev`, not by opening index.html. |
| Crypto init failed: account mismatch | DevTools -> Application -> Clear storage for localhost, log in again. |
| M_UNKNOWN_TOKEN | Session ended elsewhere; log in again. |
| HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED | Restore using the current Element Recovery Key; it unlocks the separate backup key, not the message directly. |
| No matching keys in backup | Use keys from a trusted device that still reads the messages. Do not reset the backup. |
