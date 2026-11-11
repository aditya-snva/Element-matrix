// Cross-tab coordination (same origin only) via BroadcastChannel.
//
// One Matrix device may only be run by ONE client at a time (two clients on one device
// fight over to-device messages / room keys, presence and the crypto store). So all
// tabs share one session, but only one tab runs it; the others show
// "open in another window" with a Continue button that moves the session to that tab.
//
// Messages:
//   { type: "hello" }                      new tab asks: does any tab have a session?
//   { type: "session", session }           reply from a tab that has one
//   { type: "takeover", deviceId }         "stop running this device, I'm taking it"
//   { type: "logout", deviceId }           device was logged out / revoked: forget it

const CHANNEL_NAME = "mct-tabs";
let channel = null;

export function getChannel() {
  if (!channel && typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export function broadcast(message) {
  getChannel()?.postMessage(message);
}

/** Ask other open tabs for their session. Resolves to the session, or null if none answers. */
export function askPeersForSession(timeoutMs = 400) {
  const ch = getChannel();
  if (!ch) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onMessage = (e) => {
      const s = e.data?.type === "session" ? e.data.session : null;
      if (s?.accessToken && s.userId && s.deviceId && s.baseUrl) done(s);
    };
    const done = (s) => {
      clearTimeout(timer);
      ch.removeEventListener("message", onMessage);
      resolve(s);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    ch.addEventListener("message", onMessage);
    ch.postMessage({ type: "hello" });
  });
}
