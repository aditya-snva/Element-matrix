import React from "react";
import { classifyEvent } from "../services/matrixClient.js";
import { decryptionExplanation } from "../services/messageRecovery.js";

const LABEL = {
  plain: "Not encrypted",
  decrypted: "🔓 Decrypted",
  waiting: "🔒 Waiting for room key",
  failed: "🔒 Unable to decrypt",
  pending: "🔒 Decrypting…",
};

export default function MessageBubble({ ev, mine, onRecover }) {
  const state = classifyEvent(ev);
  const ts = new Date(ev.getTs());
  const sending = ev.status && ev.status !== "sent";
  let body;
  if (state === "plain" || state === "decrypted") {
    const c = ev.getContent();
    body = c.msgtype === "m.text" || c.msgtype === "m.notice" || c.msgtype === "m.emote"
      ? c.body
      : `[${c.msgtype || ev.getType()}] ${c.body || ""}`;
  } else if (decryptionExplanation(ev.decryptionFailureReason)) {
    body = decryptionExplanation(ev.decryptionFailureReason);
  } else if (state === "waiting") {
    body = "Waiting for the room key for this message. Restore your key backup (Debug panel) or wait for another device to share it.";
  } else if (state === "failed") {
    body = `This message could not be decrypted (${ev.decryptionFailureReason || "unknown reason"}).`;
  } else body = "Decrypting…";

  return (
    <div className={`msg ${mine ? "mine" : ""} ${state}`}>
      <div className="msg-meta">
        <span className="sender">{ev.sender?.name || ev.getSender()}</span>
        <span className="time" title={ts.toISOString()}>{ts.toLocaleString()}</span>
      </div>
      <div className="bubble">{body}</div>
      <div className="msg-status">
        {LABEL[state]}{sending ? ` · ${ev.status}` : ""}
        {ev.decryptionFailureReason === "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED" &&
          <button className="btn ghost small" onClick={onRecover}>Restore old messages</button>}
      </div>
    </div>
  );
}
