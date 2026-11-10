// Recovery keys unlock secret storage; the message-backup key is a different secret.
// Only keep the supplied recovery key in memory while an explicit restore is running.
const recoveryKeys = new WeakMap();

export function createRecoveryCallbacks(getClient) {
  return {
    async getSecretStorageKey({ keys }) {
      const client = getClient();
      const key = client && recoveryKeys.get(client);
      if (!key) return null;
      for (const [id, info] of Object.entries(keys)) {
        if (info.algorithm === "m.secret_storage.v1.aes-hmac-sha2" &&
            await client.secretStorage.checkKey(key, info)) {
          return [id, key];
        }
      }
      throw new Error("This Recovery Key does not match this account's secure storage. Use its current key from Element.");
    },
  };
}

export async function restoreWithDecodedRecoveryKey(client, key, opts) {
  const crypto = client?.getCrypto();
  if (!crypto) throw new Error("Encryption is not ready. Connect before restoring messages.");
  if (recoveryKeys.has(client)) throw new Error("A message restore is already running.");
  recoveryKeys.set(client, key);
  try {
    const check = await crypto.checkKeyBackupAndEnable();
    if (!check?.backupInfo?.version) {
      throw new Error("No message backup exists for this account. Import room keys from a device that can still read these messages; do not reset its backup.");
    }
    // The SDK checks the retrieved backup key against the backup's public key
    // BEFORE saving it. Never save the recovery key itself as the backup key.
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    await crypto.checkKeyBackupAndEnable();
    const result = await crypto.restoreKeyBackup(opts);
    // SDK room-key callbacks retry pending events, emitting Decrypted events.
    return result;
  } catch (err) {
    if (/missing decryption key in secret storage/.test(err?.message || "")) {
      throw new Error("The message-backup key is missing from secure storage. Open a trusted Element session that reads the messages and check Secure Backup, or import its room keys. Do not reset the backup.");
    }
    if (err?.name === "DecryptionKeyDoesNotMatchError") {
      throw new Error("The saved message-backup key does not match the current backup. Use a trusted Element session or import its room keys; do not reset the backup.");
    }
    throw err;
  } finally {
    recoveryKeys.delete(client);
    key.fill(0);
  }
}

export async function getMessageBackupStatus(client) {
  const crypto = client?.getCrypto();
  if (!crypto) return "Encryption not ready";
  const info = await crypto.getKeyBackupInfo();
  if (!info?.version) return "No server message backup";
  const trust = await crypto.isKeyBackupTrusted(info);
  return trust.matchesDecryptionKey
    ? `Recovery configured (backup ${info.version})`
    : `Recovery Key needed (backup ${info.version})`;
}

export const WAITING_REASONS = new Set([
  "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
  "OLM_UNKNOWN_MESSAGE_INDEX",
  "HISTORICAL_MESSAGE_WORKING_BACKUP",
  "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED",
]);

export function messageState(ev) {
  if (!ev.isEncrypted()) return "plain";
  if (ev.isBeingDecrypted()) return "pending";
  if (ev.isDecryptionFailure()) {
    return WAITING_REASONS.has(ev.decryptionFailureReason) ? "waiting" : "failed";
  }
  return ev.getClearContent() ? "decrypted" : "pending";
}

export function decryptionExplanation(reason) {
  if (reason === "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED") {
    return "This older message is encrypted. Its backup needs your Recovery Key before it can be read.";
  }
  if (reason === "HISTORICAL_MESSAGE_NO_KEY_BACKUP") {
    return "This older message is encrypted and no server key backup exists. Import its room keys from a device that can still read it.";
  }
  if (reason === "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE") {
    return "The sender withheld this message's key because this device is unverified. Verify it from a trusted Element session.";
  }
  return null;
}