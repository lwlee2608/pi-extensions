const PORT = 47823;
const ALARM_MINUTES = 0.5;
const KEEPALIVE_MS = 20_000;
const NAVIGATE_WAIT_MS = 20_000;
const GROUP = "pi";

const SKIP = new Set(["generic", "none", "paragraph", "InlineTextBox", "LineBreak", "RootWebArea"]);
const INTERACTIVE = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem"]);

const handlers = {
  async tabs() {
    const all = await chrome.tabs.query({});
    const tabs = await piTabs();
    return {
      tabs: tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, current: tab.id === current })),
      others: all.length - tabs.length,
    };
  },

  async tab({ tabId }) {
    const tab = await piTab(tabId);
    return { id: tab.id, url: tab.url };
  },

  async navigate({ url, tabId, newTab }) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`navigate only opens http and https URLs: ${url}`);
    const tab = newTab || (tabId === undefined && !(await piTabs()).length) ? await openTab() : await piTab(tabId);
    await cdp(tab.id, "Page.enable");
    const outcome = await load(tab.id, url);
    if (outcome === "gone") throw new Error(`Tab ${tab.id} closed or detached while loading ${url}.`);
    const loaded = await chrome.tabs.get(tab.id);
    return { url: loaded.url, text: `${describe(loaded)}${outcome === "timeout" ? " (still loading)" : ""}` };
  },

  async read({ tabId }) {
    const tab = await piTab(tabId);
    const { frameTree } = await cdp(tab.id, "Page.getFrameTree");
    const lines = [describe(tab)];
    for (const frameId of frameIds(frameTree)) {
      const { nodes } = await cdp(tab.id, "Accessibility.getFullAXTree", { frameId }).catch(() => ({ nodes: [] }));
      snapshot(nodes, lines);
    }
    return { url: (await chrome.tabs.get(tab.id)).url, text: lines.join("\n") };
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
      await allowed();
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

async function allowed() {
  if ((await chrome.storage.session.get("canceled")).canceled) {
    throw new Error("Debugging was canceled in Chrome. Click the Pi Browser toolbar icon to allow it again.");
  }
}

async function cdp(tabId, method, params) {
  if (!attached.has(tabId)) {
    await allowed();
    await chrome.debugger.attach({ tabId }, "1.3").catch(error => { if (!/already attached/i.test(error.message)) throw error; });
    attached.add(tabId);
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function load(tabId, url) {
  const loaded = new Set();
  let mainLoader, loaderId, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === "Page.frameNavigated" && !params.frame.parentId) mainLoader = params.frame.loaderId;
    if (method === "Page.loadEventFired") loaded.add(mainLoader);
    if (loaderId && loaded.has(loaderId)) finish("loaded");
  };
  const onGone = source => { if ((source.tabId ?? source) === tabId) finish("gone"); };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onGone);
  chrome.tabs.onRemoved.addListener(onGone);
  const timer = setTimeout(() => finish("timeout"), NAVIGATE_WAIT_MS);
  try {
    const result = await cdp(tabId, "Page.navigate", { url });
    if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
    if (!result.loaderId) return "loaded";
    loaderId = result.loaderId;
    if (loaded.has(loaderId)) return "loaded";
    return await done;
  } finally {
    clearTimeout(timer);
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onGone);
    chrome.tabs.onRemoved.removeListener(onGone);
  }
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

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId);
  if (reason !== "canceled_by_user") return;
  chrome.storage.session.set({ canceled: true });
  detachAll();
});
chrome.tabs.onUpdated.addListener(async (tabId, { groupId }) => {
  if (groupId === undefined || !attached.has(tabId)) return;
  const group = groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? undefined : await chrome.tabGroups.get(groupId);
  if (group?.title !== GROUP) { attached.delete(tabId); chrome.debugger.detach({ tabId }).catch(() => {}); }
});
chrome.alarms.create("connect", { periodInMinutes: ALARM_MINUTES });
chrome.alarms.onAlarm.addListener(connect);
chrome.action.onClicked.addListener(() => chrome.storage.session.remove("canceled").then(connect));
connect();
