const PORT = 47823;
const ALARM_MINUTES = 0.5;
const KEEPALIVE_MS = 20_000;

const handlers = {};
let socket;

function connect() {
  if (socket) return;
  const ws = socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
  let keepalive;
  ws.onopen = () => {
    keepalive = setInterval(() => ws.send("{}"), KEEPALIVE_MS);
    chrome.action.setTitle({ title: "Pi Browser: connected" });
  };
  ws.onmessage = async ({ data }) => {
    const { id, method, params } = JSON.parse(data);
    try {
      if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown browser action: ${method}`);
      ws.send(JSON.stringify({ id, result: await handlers[method](params ?? {}) }));
    } catch (error) {
      ws.send(JSON.stringify({ id, error: error?.message ?? String(error) }));
    }
  };
  ws.onclose = ({ code, reason }) => {
    clearInterval(keepalive);
    if (socket === ws) socket = undefined;
    chrome.action.setTitle({ title: code === 4409 ? `Pi Browser: ${reason}` : "Pi Browser: not connected" });
    detachAll();
  };
}

async function detachAll() {
  for (const target of await chrome.debugger.getTargets()) {
    if (target.attached && target.tabId !== undefined) chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
  }
}

chrome.alarms.create("connect", { periodInMinutes: ALARM_MINUTES });
chrome.alarms.onAlarm.addListener(connect);
chrome.action.onClicked.addListener(connect);
connect();
