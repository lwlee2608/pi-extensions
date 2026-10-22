const PORT = 47823;
const ALARM_MINUTES = 0.5;
const KEEPALIVE_MS = 20_000;
const NAVIGATE_WAIT_MS = 20_000;
const GROUP = "pi";
const SCREENSHOT_QUALITY = 80;

const SKIP = new Set(["generic", "none", "paragraph", "InlineTextBox", "LineBreak", "RootWebArea"]);
const INTERACTIVE = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem"]);

const handlers = {
  async tabs() {
    const all = await chrome.tabs.query({});
    const tabs = await piTabs();
    return {
      tabs: tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url || tab.pendingUrl || "", current: tab.id === current })),
      others: all.length - tabs.length,
    };
  },

  async tab({ tabId }) {
    const tab = await piTab(tabId);
    return { id: tab.id, url: tab.url || tab.pendingUrl || "" };
  },

  async navigate({ url, tabId, newTab }) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`navigate only opens http and https URLs: ${url}`);
    const tab = newTab || (tabId === undefined && !(await piTabs()).length) ? await openTab() : await piTab(tabId);
    const outcome = await load(tab.id, url);
    if (outcome === "gone") throw new Error(`Tab ${tab.id} closed or detached while loading ${url}.`);
    const loaded = await chrome.tabs.get(tab.id);
    const committed = loaded.url === "about:blank" ? "" : loaded.url;
    return { url: committed || loaded.pendingUrl || loaded.url || "", text: `${describe(loaded)}${outcome === "timeout" ? " (still loading)" : ""}` };
  },

  async read({ tabId }) {
    const tab = await piTab(tabId);
    const { frameTree } = await cdp(tab.id, "Page.getFrameTree");
    const lines = [describe(tab)];
    const frames = new Map();
    refs.set(tab.id, frames);
    for (const frameId of frameIds(frameTree)) {
      const found = new Set();
      frames.set(frameId, found);
      const { nodes } = await cdp(tab.id, "Accessibility.getFullAXTree", { frameId }).catch(() => ({ nodes: [] }));
      snapshot(nodes, lines, found);
    }
    const done = await chrome.tabs.get(tab.id);
    return { url: done.url || done.pendingUrl || "", text: lines.join("\n") };
  },

  async click({ tabId, ref }) {
    const tab = await piTab(tabId);
    await node(tab.id, "DOM.scrollIntoViewIfNeeded", ref);
    const { quads } = await node(tab.id, "DOM.getContentQuads", ref);
    if (!quads?.length) throw new Error(`Ref [${ref}] has no visible box to click.`);
    const x = (quads[0][0] + quads[0][2] + quads[0][4] + quads[0][6]) / 4;
    const y = (quads[0][1] + quads[0][3] + quads[0][5] + quads[0][7]) / 4;
    await guarded(tab.id, async () => {
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    });
    return acted(tab.id, `Clicked [${ref}]`);
  },

  async type({ tabId, ref, text }) {
    if (typeof text !== "string") throw new Error("type needs text.");
    const tab = await piTab(tabId);
    await node(tab.id, "DOM.focus", ref);
    await guarded(tab.id, () => cdp(tab.id, "Input.insertText", { text }));
    return acted(tab.id, `Typed ${text.length} characters into [${ref}]`);
  },

  async keys({ tabId, ref, keys }) {
    const combos = typeof keys === "string" ? keys.trim().split(/\s+/).filter(Boolean) : [];
    if (!combos.length) throw new Error("keys needs key names, like \"Enter\" or \"Shift+Tab\".");
    const mac = (await chrome.runtime.getPlatformInfo()).os === "mac";
    const presses = combos.map(combo => parseCombo(combo, mac));
    const tab = await piTab(tabId);
    if (ref !== undefined) await node(tab.id, "DOM.focus", ref);
    await guarded(tab.id, async () => { for (const press of presses) await pressKeys(tab.id, press); });
    return acted(tab.id, `Pressed ${combos.join(" ")}`);
  },

  async scroll({ tabId, ref }) {
    const tab = await piTab(tabId);
    await node(tab.id, "DOM.scrollIntoViewIfNeeded", ref);
    return acted(tab.id, `Scrolled [${ref}] into view`);
  },

  async screenshot({ tabId }) {
    const tab = await piTab(tabId);
    await chrome.tabs.update(tab.id, { active: true });
    const { cssVisualViewport: css, visualViewport: device } = await cdp(tab.id, "Page.getLayoutMetrics");
    const clip = { x: css.pageX, y: css.pageY, width: css.clientWidth, height: css.clientHeight, scale: css.clientWidth / device.clientWidth };
    const { data } = await cdp(tab.id, "Page.captureScreenshot", { format: "jpeg", quality: SCREENSHOT_QUALITY, clip });
    return { ...(await acted(tab.id, "Screenshot")), data };
  },
};

const KEYS = {
  Enter: [13, "Enter", "\r"], Tab: [9, "Tab"], Escape: [27, "Escape"], Backspace: [8, "Backspace"], Delete: [46, "Delete"],
  Space: [32, "Space", " "], ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], ArrowLeft: [37, "ArrowLeft"],
  ArrowRight: [39, "ArrowRight"], Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"],
};
const MODIFIERS = { Alt: [1, 18], Control: [2, 17], Meta: [4, 91], Shift: [8, 16] };
const MAC_COMMANDS = { Meta: { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" }, "Meta+Shift": { z: "redo" } };

const attached = new Set();
const refs = new Map();
const dialogs = new Map();
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
  if (dialogs.has(tabId)) throw dialogError(dialogs.get(tabId));
  if (!attached.has(tabId)) {
    await allowed();
    await chrome.debugger.attach({ tabId }, "1.3").catch(error => { if (!/already attached/i.test(error.message)) throw error; });
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
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
    const navigated = cdp(tabId, "Page.navigate", { url });
    navigated.catch(() => {});
    const result = await Promise.race([navigated, done]);
    if (typeof result === "string") return result;
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

function dialogError(type) {
  return new Error(`The page opened a ${type} dialog, which blocks the tab. Ask the user to answer it in Chrome, then read.`);
}

async function guarded(tabId, run) {
  let onEvent;
  const dialog = new Promise((_, reject) => {
    onEvent = (source, method, params) => {
      if (source.tabId !== tabId || method !== "Page.javascriptDialogOpening") return;
      reject(dialogError(params.type));
    };
    chrome.debugger.onEvent.addListener(onEvent);
  });
  const action = run();
  action.catch(() => {});
  try {
    return await Promise.race([action, dialog]);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

async function node(tabId, method, ref) {
  if (!Number.isInteger(ref)) throw new Error("This action needs a ref: the number in [n] from read.");
  if (![...refs.get(tabId)?.values() ?? []].some(found => found.has(ref))) throw new Error(`Ref [${ref}] is gone or was never in this tab's last read; the page may have navigated. Use read for fresh refs.`);
  try {
    return await cdp(tabId, method, { backendNodeId: ref });
  } catch (error) {
    if (/no node|layout object/i.test(error.message)) throw new Error(`Ref [${ref}] is no longer on the page. Use read for fresh refs.`);
    throw error;
  }
}

async function acted(tabId, what) {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url || tab.pendingUrl || "", text: `${what} in tab ${tabId}.` };
}

function parseCombo(combo, mac) {
  const parts = combo.split("+");
  const name = parts.pop();
  const unknown = parts.find(part => !Object.hasOwn(MODIFIERS, part));
  if (unknown !== undefined || !name) throw new Error(`Unknown key combo ${combo}. Use modifiers ${Object.keys(MODIFIERS).join(", ")} with + and a key.`);
  const modifiers = parts.reduce((bits, part) => bits | MODIFIERS[part][0], 0);
  if (Object.hasOwn(KEYS, name)) {
    const [keyCode, code, text] = KEYS[name];
    return { modifiers: parts, key: { key: name === "Space" ? " " : name, code, keyCode, text, modifiers } };
  }
  if ([...name].length !== 1) throw new Error(`Unknown key ${name}. Use one character or one of ${Object.keys(KEYS).join(", ")}.`);
  const upper = name.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : undefined;
  const typed = (modifiers & ~MODIFIERS.Shift[0]) === 0;
  const commands = mac ? MAC_COMMANDS[parts.toSorted().join("+")]?.[name.toLowerCase()] : undefined;
  return { modifiers: parts, key: { key: name, code, keyCode: code ? upper.charCodeAt(0) : undefined, text: typed ? name : undefined, modifiers, commands: commands && [commands] } };
}

async function pressKeys(tabId, { modifiers, key }) {
  let held = 0;
  const send = (type, event) => cdp(tabId, "Input.dispatchKeyEvent", {
    type, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, text: type === "keyDown" ? event.text : undefined, modifiers: event.modifiers,
    commands: type === "keyUp" ? undefined : event.commands,
  });
  for (const name of modifiers) {
    held |= MODIFIERS[name][0];
    await send("rawKeyDown", { key: name, code: `${name}Left`, keyCode: MODIFIERS[name][1], modifiers: held });
  }
  await send(key.text ? "keyDown" : "rawKeyDown", key);
  await send("keyUp", key);
  for (const name of modifiers.toReversed()) {
    held &= ~MODIFIERS[name][0];
    await send("keyUp", { key: name, code: `${name}Left`, keyCode: MODIFIERS[name][1], modifiers: held });
  }
}

function describe(tab) {
  return `Tab ${tab.id}: ${tab.title || "(untitled)"} <${tab.url}>`;
}

function frameIds({ frame, childFrames = [] }) {
  return [frame.id, ...childFrames.flatMap(frameIds)];
}

function snapshot(nodes, lines, found) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const walk = (node, depth, parentName) => {
    const role = node.role?.value;
    const name = String(node.name?.value ?? "").trim();
    if (!node.ignored && !SKIP.has(role)) {
      if (role === "StaticText") {
        if (name && name !== parentName) lines.push(`${"  ".repeat(depth)}${name}`);
      } else {
        const interactive = INTERACTIVE.has(role) && node.backendDOMNodeId;
        if (interactive) found.add(node.backendDOMNodeId);
        const ref = interactive ? `[${node.backendDOMNodeId}] ` : "";
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
  refs.clear();
  dialogs.clear();
  for (const target of await chrome.debugger.getTargets()) {
    if (target.attached && target.tabId !== undefined) chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
  }
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === "Page.frameNavigated" && !params.frame.parentId) refs.delete(tabId);
  else if (method === "Page.frameNavigated") refs.get(tabId)?.delete(params.frame.id);
  else if (method === "Page.frameDetached") refs.get(tabId)?.delete(params.frameId);
  else if (method === "Page.javascriptDialogOpening") dialogs.set(tabId, params.type);
  else if (method === "Page.javascriptDialogClosed") dialogs.delete(tabId);
});
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId);
  refs.delete(tabId);
  dialogs.delete(tabId);
  if (reason !== "canceled_by_user") return;
  chrome.storage.session.set({ canceled: true });
  detachAll();
});
chrome.tabs.onUpdated.addListener(async (tabId, { groupId }) => {
  if (groupId === undefined || !attached.has(tabId)) return;
  const group = groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? undefined : await chrome.tabGroups.get(groupId);
  if (group?.title !== GROUP) { attached.delete(tabId); refs.delete(tabId); dialogs.delete(tabId); chrome.debugger.detach({ tabId }).catch(() => {}); }
});
chrome.alarms.create("connect", { periodInMinutes: ALARM_MINUTES });
chrome.alarms.onAlarm.addListener(connect);
chrome.action.onClicked.addListener(() => chrome.storage.session.remove("canceled").then(connect));
connect();
