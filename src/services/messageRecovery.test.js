import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryCallbacks, restoreWithDecodedRecoveryKey, getMessageBackupStatus, messageState } from "./messageRecovery.js";

function fixture({ matches = true, backup = true, failure = null } = {}) {
  const recovery = new Uint8Array(32).fill(7);
  const backupKey = new Uint8Array(32).fill(9);
  const calls = [];
  let storedKey;
  let client;
  const callbacks = createRecoveryCallbacks(() => client);
  const crypto = {
    async checkKeyBackupAndEnable() {
      calls.push("check");
      return backup ? { backupInfo: { version: "3" } } : null;
    },
    async loadSessionBackupPrivateKeyFromSecretStorage() {
      calls.push("secret-storage");
      const result = await callbacks.getSecretStorageKey({ keys: {
        "secure-storage-key": { algorithm: "m.secret_storage.v1.aes-hmac-sha2" },
      } });
      assert.equal(result[0], "secure-storage-key");
      assert.equal(result[1], recovery);
      if (failure) throw failure;
      storedKey = backupKey;
    },
    async restoreKeyBackup() {
      calls.push("restore");
      assert.equal(storedKey, backupKey);
      assert.notEqual(storedKey, recovery);
      return { total: 2, imported: 2 };
    },
    async getKeyBackupInfo() { return backup ? { version: "3" } : null; },
    async isKeyBackupTrusted() { return { matchesDecryptionKey: !!storedKey }; },
    async storeSessionBackupPrivateKey() { assert.fail("Recovery key must never be stored as the message-backup key"); },
    async resetKeyBackup() { assert.fail("Existing backup must never be reset"); },
  };
  client = {
    getCrypto: () => crypto,
    secretStorage: { async checkKey(key) { return matches && key === recovery; } },
  };
  return { client, callbacks, recovery, calls };
}

test("Element Recovery Key unlocks secure storage before restoring the separate message-backup key", async () => {
  const f = fixture();
  assert.deepEqual(await restoreWithDecodedRecoveryKey(f.client, f.recovery), { total: 2, imported: 2 });
  assert.deepEqual(f.calls, ["check", "secret-storage", "check", "restore"]);
  assert.deepEqual([...f.recovery], Array(32).fill(0));
  assert.equal(await f.callbacks.getSecretStorageKey({ keys: {} }), null);
  assert.equal(await getMessageBackupStatus(f.client), "Recovery configured (backup 3)");
});

test("wrong Recovery Key is rejected without restore or overwriting the backup", async () => {
  const f = fixture({ matches: false });
  await assert.rejects(restoreWithDecodedRecoveryKey(f.client, f.recovery), /does not match/);
  assert.deepEqual(f.calls, ["check", "secret-storage"]);
  assert.equal(f.recovery.every((b) => b === 0), true);
  assert.equal(await f.callbacks.getSecretStorageKey({ keys: {} }), null);
});

test("missing server backup never creates a replacement", async () => {
  const f = fixture({ backup: false });
  await assert.rejects(restoreWithDecodedRecoveryKey(f.client, f.recovery), /No message backup/);
  assert.deepEqual(f.calls, ["check"]);
  assert.equal(f.recovery.every((b) => b === 0), true);
});

test("failed secret-storage read clears recovery bytes and prevents restore", async () => {
  const f = fixture({ failure: new Error("missing decryption key in secret storage") });
  await assert.rejects(restoreWithDecodedRecoveryKey(f.client, f.recovery), /message-backup key is missing/);
  assert.deepEqual(f.calls, ["check", "secret-storage"]);
  assert.equal(await f.callbacks.getSecretStorageKey({ keys: {} }), null);
  assert.equal(f.recovery.every((b) => b === 0), true);
});

test("unconfigured historical encrypted messages wait for recovery; they are not plaintext", () => {
  const ev = { isEncrypted: () => true, isBeingDecrypted: () => false, isDecryptionFailure: () => true,
    decryptionFailureReason: "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED" };
  assert.equal(messageState(ev), "waiting");
});

test("unencrypted room messages remain plaintext even with a stale failure reason", () => {
  assert.equal(messageState({ isEncrypted: () => false,
    decryptionFailureReason: "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED" }), "plain");
});

test("successfully decrypted encrypted messages use clear content", () => {
  assert.equal(messageState({ isEncrypted: () => true, isBeingDecrypted: () => false,
    isDecryptionFailure: () => false, getClearContent: () => ({ body: "Old message" }) }), "decrypted");
});