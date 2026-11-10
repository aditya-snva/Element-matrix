import React from "react";
import { latestDisplayable, previewFor } from "../services/matrixClient.js";

export default function RoomList({ rooms, selectedId, onSelect, loading }) {
  const sorted = [...rooms].sort((a, b) => (b.getLastActiveTimestamp() || 0) - (a.getLastActiveTimestamp() || 0));
  return (
    <aside className="sidebar">
      <div className="sidebar-title">Rooms {loading ? <span className="spinner" /> : <span className="muted">({rooms.length})</span>}</div>
      {!loading && rooms.length === 0 && <div className="muted pad">No joined rooms.</div>}
      <ul>
        {sorted.map((r) => {
          const last = latestDisplayable(r);
          const unread = r.getUnreadNotificationCount?.("total") || 0;
          const name = r.name && r.name !== r.roomId ? r.name : r.roomId;
          return (
            <li key={r.roomId} className={r.roomId === selectedId ? "room selected" : "room"} onClick={() => onSelect(r.roomId)}>
              <div className="room-top">
                <span className="room-name">{r.hasEncryptionStateEvent() ? "🔒 " : ""}{name}</span>
                {unread > 0 && <span className="badge">{unread}</span>}
              </div>
              <div className="room-id">{r.roomId}</div>
              {last && <div className="room-preview">{last.sender?.name || last.getSender()}: {previewFor(last)}</div>}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
