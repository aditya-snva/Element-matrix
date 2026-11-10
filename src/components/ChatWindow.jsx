import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import MessageBubble from "./MessageBubble.jsx";
import { isDisplayable } from "../services/matrixClient.js";

export default function ChatWindow({ room, client, sendText, loadOlder, onRecover }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const listRef = useRef(null);
  const stickBottom = useRef(true);
  const sendingRef = useRef(false);

  const events = room ? room.getLiveTimeline().getEvents().filter(isDisplayable) : [];
  // De-duplicate by event id (local echo + remote echo share the same id after send).
  const seen = new Set();
  const unique = events.filter((e) => { const id = e.getId() || e.getTxnId(); if (seen.has(id)) return false; seen.add(id); return true; });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => { if (room) client?.sendReadReceipt?.(room.getLiveTimeline().getEvents().at(-1))?.catch(() => {}); }, [room, client, unique.length]);

  if (!room) return <section className="chat empty"><div className="muted">Select a room to start chatting.</div></section>;

  const onScroll = () => {
    const el = listRef.current;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const older = async () => {
    setLoadingOlder(true);
    const prevH = listRef.current.scrollHeight;
    stickBottom.current = false;
    const more = await loadOlder(room.roomId);
    setHasMore(more);
    setLoadingOlder(false);
    requestAnimationFrame(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight - prevH; });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sendingRef.current) return; // prevents duplicate sends
    sendingRef.current = true; setSending(true); setSendError(null);
    try {
      await sendText(room.roomId, body);
      setText(""); // clear only after success
      stickBottom.current = true;
    } catch (e) {
      setSendError(e.message);
    } finally {
      sendingRef.current = false; setSending(false);
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  const me = client?.getUserId();
  const name = room.name && room.name !== room.roomId ? room.name : room.roomId;

  return (
    <section className="chat">
      <div className="chat-head">
        <div className="chat-name">{room.hasEncryptionStateEvent() ? "🔒 " : ""}{name}</div>
        <div className="room-id">{room.roomId}</div>
      </div>
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {hasMore && (
          <button className="btn ghost small center" onClick={older} disabled={loadingOlder}>
            {loadingOlder ? "Loading…" : "Load older messages"}
          </button>
        )}
        {unique.length === 0 && <div className="muted pad">No messages yet.</div>}
        {unique.map((ev) => <MessageBubble key={ev.getId() || ev.getTxnId()} ev={ev} mine={ev.getSender() === me} onRecover={onRecover} />)}
      </div>
      <div className="composer">
        {sendError && <div className="error small">Failed to send: {sendError}</div>}
        <div className="composer-row">
          <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={2}
            placeholder="Type a message… (Enter to send, Shift+Enter for new line)" />
          <button className="btn primary" onClick={send} disabled={!text.trim() || sending}>
            {sending ? <><span className="spinner" /> Sending</> : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}
