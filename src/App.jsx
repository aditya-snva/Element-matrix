import React, { useEffect, useMemo, useState } from "react";
import LoginForm from "./components/LoginForm.jsx";
import RoomList from "./components/RoomList.jsx";
import ChatWindow from "./components/ChatWindow.jsx";
import DebugPanel from "./components/DebugPanel.jsx";
import { useMatrixClient } from "./hooks/useMatrixClient.js";

export default function App() {
  const m = useMatrixClient();
  const [roomId, setRoomId] = useState(null);
  const [recoveryRequest, setRecoveryRequest] = useState(0);
  const loggedIn = ["syncing", "ready"].includes(m.phase) && m.session;

  const rooms = useMemo(() => {
    if (!m.client) return [];
    return m.client.getRooms().filter((r) => r.getMyMembership() === "join");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.client, m.version]);

  useEffect(() => { if (!loggedIn) setRoomId(null); }, [loggedIn]);

  const room = roomId ? m.client?.getRoom(roomId) : null;
  const msgCount = room ? room.getLiveTimeline().getEvents().length : 0;

  return (
    <div className="app">
      <header className="header">
        <h1>Matrix Chat Tester</h1>
        <div className="header-right">
          <span className={`pill ${m.phase === "ready" && m.syncState !== "ERROR" && m.syncState !== "RECONNECTING" ? "ok" : m.phase === "error" ? "bad" : "warn"}`}>
            {m.status}
          </span>
          {m.session && <span className="mxid">{m.session.userId}</span>}
          {loggedIn && <button className="btn ghost" onClick={m.logout}>Log out</button>}
        </div>
      </header>

      {!loggedIn ? (
        <LoginForm onLogin={m.login} phase={m.phase} status={m.status} error={m.loginError} />
      ) : (
        <main className="main">
          <RoomList rooms={rooms} selectedId={roomId} onSelect={setRoomId} loading={m.phase !== "ready"} version={m.version} />
          <ChatWindow key={roomId || "none"} room={room} client={m.client} sendText={m.sendText} loadOlder={m.loadOlder} version={m.version} pushError={m.pushError} onRecover={() => setRecoveryRequest((v) => v + 1)} />
        </main>
      )}

      <DebugPanel
        homeserver={m.session?.baseUrl}
        userId={m.session?.userId}
        deviceId={m.session?.deviceId}
        status={m.status}
        syncState={m.syncState}
        cryptoStatus={m.cryptoStatus}
        roomId={roomId}
        roomEncrypted={room ? room.hasEncryptionStateEvent() : undefined}
        msgCount={msgCount}
        errors={m.errors}
        client={m.client}
        canRestore={!!m.client && m.cryptoStatus.startsWith("ready")}
        pushError={m.pushError}
        recoveryRequest={recoveryRequest}
        onRecovered={m.refresh}
      />
    </div>
  );
}
