const PORT = 47823;
const ALARM_MINUTES = 0.5;
const KEEPALIVE_MS = 20_000;
const GROUP = "pi";

const SKIP = new Set(["generic", "none", "paragraph", "InlineTextBox", "LineBreak", "RootWebArea"]);
const INTERACTIVE = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem"]);

const handlers = {
  async tabs() {
    const all = await chrome.tabs.query({});
    const tabs = await piTabs();
    const lines = tabs.map(tab => `${describe(tab)}${tab.id === current ? " (current)" : ""}`);
    return [...(lines.length ? lines : ["No pi tabs are open."]), `${all.length - tabs.length} other tabs are not in the pi group.`].join("\n");
  },

  async navigate({ url, tabId, newTab }) {
    const tab = newTab || (tabId === undefined && !(await piTabs()).length) ? await openTab() : await piTab(tabId);
    await cdp(tab.id, "Page.enable");
    let listener;
    const loaded = new Promise(resolve => {
      listener = (source, method) => { if (source.tabId === tab.id && method === "Page.loadEventFired") resolve(); };
      chrome.debugger.onEvent.addListener(listener);
    });
    try {
      const { errorText, loaderId } = await cdp(tab.id, "Page.navigate", { url });
      if (errorText) throw new Error(`Navigation to ${url} failed: ${errorText}`);
      if (loaderId) await loaded;
    } finally {
      chrome.debugger.onEvent.removeListener(listener);
    }
    return describe(await chrome.tabs.get(tab.id));
  },

  async read({ tabId }) {
    const tab = await piTab(tabId);
    const { frameTree } = await cdp(tab.id, "Page.getFrameTree");
    const lines = [describe(tab)];
    for (const frameId of frameIds(frameTree)) {
      const { nodes } = await cdp(tab.id, "Accessibility.getFullAXTree", { frameId }).catch(() => ({ nodes: [] }));
      snapshot(nodes, lines);
    }
    return lines.join("\n");
  },
};

const attached = new Set();
let socket;
let current;

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

async function piTabs() {
  const groups = new Set((await chrome.tabGroups.query({ title: GROUP })).map(group => group.id));
  return (await chrome.tabs.query({})).filter(tab => groups.has(tab.groupId));
}

async function piTab(tabId) {
  const tabs = await piTabs();
  const tab = tabId === undefined ? tabs.find(tab => tab.id === current) ?? tabs.at(-1) : tabs.find(tab => tab.id === tabId);
  if (!tab) throw new Error(tabId === undefined ? "No pi tabs are open. Use navigate first." : `Tab ${tabId} is not in the pi tab group.`);
  current = tab.id;
  return tab;
}

async function openTab() {
  const [group] = await chrome.tabGroups.query({ title: GROUP });
  const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: group?.windowId });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], groupId: group?.id });
  if (!group) await chrome.tabGroups.update(groupId, { title: GROUP, color: "blue" });
  current = tab.id;
  return tab;
}

async function cdp(tabId, method, params) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3").catch(error => { if (!/already attached/i.test(error.message)) throw error; });
    attached.add(tabId);
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function describe(tab) {
  return `Tab ${tab.id}: ${tab.title || "(untitled)"} <${tab.url}>`;
}

function frameIds({ frame, childFrames = [] }) {
  return [frame.id, ...childFrames.flatMap(frameIds)];
}

function snapshot(nodes, lines) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const walk = (node, depth, parentName) => {
    const role = node.role?.value;
    const name = String(node.name?.value ?? "").trim();
    if (!node.ignored && !SKIP.has(role)) {
      if (role === "StaticText") {
        if (name && name !== parentName) lines.push(`${"  ".repeat(depth)}${name}`);
      } else {
        const ref = INTERACTIVE.has(role) && node.backendDOMNodeId ? `[${node.backendDOMNodeId}] ` : "";
        const value = node.value?.value ? ` = ${JSON.stringify(String(node.value.value))}` : "";
        lines.push(`${"  ".repeat(depth)}${ref}${role}${name ? ` ${JSON.stringify(name)}` : ""}${value}`);
        depth++;
        parentName = name;
      }
    }
    for (const id of node.childIds ?? []) if (byId.has(id)) walk(byId.get(id), depth, parentName);
  };
  for (const node of nodes) if (!node.parentId) walk(node, 0, "");
}

async function detachAll() {
  attached.clear();
  for (const target of await chrome.debugger.getTargets()) {
    if (target.attached && target.tabId !== undefined) chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
  }
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.tabs.onUpdated.addListener(async (tabId, { groupId }) => {
  if (groupId === undefined || !attached.has(tabId)) return;
  const group = groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? undefined : await chrome.tabGroups.get(groupId);
  if (group?.title !== GROUP) chrome.debugger.detach({ tabId }).catch(() => {});
});
chrome.alarms.create("connect", { periodInMinutes: ALARM_MINUTES });
chrome.alarms.onAlarm.addListener(connect);
chrome.action.onClicked.addListener(connect);
connect();
