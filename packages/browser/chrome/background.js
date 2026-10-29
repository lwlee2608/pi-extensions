const HOST = "com.lwlee2608.pi_browser";
const PROTOCOL = 2;
const RECONNECT_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const NAVIGATE_WAIT_MS = 20_000;
const COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
const SCREENSHOT_QUALITY = 80;
const SCREENSHOT_EDGE = 1568;
const SCREENSHOT_AREA = 1_150_000;
const LOG_LIMIT = 200;
const TEXT_LIMIT = 1_000;
const EVAL_TIMEOUT_MS = 10_000;
const CURSOR_MOVE_MS = 250;
const OVERLAY_IDLE_MS = 120_000;
const OVERLAY_WAIT_MS = 1_000;
const OVERLAY_WORLD = "pi-overlay";
const STOP_BINDING = "piStop";
const STRIP_TRIES = 4;
const STRIP_WAIT_MS = 75;
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }] };
const FOCUSED = "function () { return this.isContentEditable || (this !== this.ownerDocument.body && this !== this.ownerDocument.documentElement); }";

const SKIP = new Set(["generic", "none", "paragraph", "InlineTextBox", "LineBreak", "RootWebArea"]);
const INTERACTIVE = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem"]);

const handlers = {
  hello() {
    return { version: PROTOCOL, host: hostVersion };
  },

  async tabs(_, caller) {
    const all = await chrome.tabs.query({});
    const tabs = await piTabs(caller);
    return {
      tabs: tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url || tab.pendingUrl || "", current: tab.id === current.get(caller.id) })),
      others: all.length - tabs.length,
    };
  },

  async tab({ tabId }, caller) {
    const tab = await piTab(caller, tabId);
    return { id: tab.id, url: tab.url || tab.pendingUrl || "" };
  },

  async navigate({ url, tabId, newTab }, caller) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`navigate only opens http and https URLs: ${url}`);
    const tab = newTab || (tabId === undefined && !(await piTabs(caller)).length) ? await openTab(caller) : await piTab(caller, tabId);
    const outcome = await load(tab.id, url);
    if (outcome === "gone" && !(await chrome.tabs.get(tab.id).catch(() => undefined))) throw new Error(`Tab ${tab.id} closed while loading ${url}.`);
    await overlay(tab.id, "show");
    const loaded = await chrome.tabs.get(tab.id);
    const committed = loaded.url === "about:blank" ? "" : loaded.url;
    return { url: committed || loaded.pendingUrl || loaded.url || "", text: `${describe(committed ? loaded : { ...loaded, title: "" })}${outcome === "timeout" ? " (still loading)" : ""}` };
  },

  async read({ tabId }, caller) {
    const tab = await piTab(caller, tabId);
    await overlay(tab.id, "show");
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

  async click({ tabId, ref, point, button = "left", clickCount = 1, hosts = [] }, caller) {
    if ((ref === undefined) === (point === undefined)) throw new Error("click needs either a ref from read or a point from a screenshot, not both.");
    if (!Object.hasOwn(BUTTONS, button)) throw new Error(`click's button is left or right, not ${button}.`);
    if (![1, 2, 3].includes(clickCount)) throw new Error(`click's clickCount is 1, 2, or 3, not ${clickCount}.`);
    const tab = await piTab(caller, tabId);
    let at = point === undefined ? undefined : spot(tab.id, point);
    let what = `[${ref}]`;
    let ask;
    await inFront(tab, async () => {
      const where = at ? `Point (${point.join(", ")})` : `Ref [${ref}]`;
      if (at) {
        const frame = await frameAt(tab.id, at, where);
        if ((ask = unapproved(frame, hosts, where))) return;
        await overlay(tab.id, "aim", at);
        what = `at (${point.join(", ")}) on ${await named(tab.id, frame.hit.backendNodeId, frame.node, frame.sessionId)}${foreign(frame)}`;
      } else {
        await overlay(tab.id, "aim", await reveal(tab.id, ref));
        at = await center(tab.id, ref);
        if (!at) throw new Error(`Ref [${ref}] has no visible box to click.`);
        await uncovered(tab.id, ref, at);
        if ((ask = unapproved(await frameAt(tab.id, at, where), hosts, where))) return;
      }
      const check = async done => {
        const url = unapproved(await frameAt(tab.id, at, where), hosts, where);
        if (url) throw new Error(`During the click the page put content from ${hostOf(url) ?? url} under ${where.toLowerCase()}, so it stopped after ${done} of ${clickCount} presses. ${point ? "Take a new screenshot" : "Read again"} and try again.`);
      };
      await guarded(tab.id, () => press(tab.id, at, button, clickCount, check));
    }).finally(() => { overlay(tab.id, "show"); });
    if (ask) return { ...(await reply(tab.id, "")), ask };
    return acted(tab.id, `${CLICKED[clickCount - 1]} ${what}${button === "right" ? " with the right button" : ""}`);
  },

  async type({ tabId, ref, text, hosts = [] }, caller) {
    if (typeof text !== "string") throw new Error("type needs text.");
    const tab = await piTab(caller, tabId);
    await overlay(tab.id, "show", ref === undefined ? undefined : await reveal(tab.id, ref).catch(() => undefined));
    if (ref !== undefined) await node(tab.id, "DOM.focus", ref);
    const focus = await focusIn(tab.id);
    if (ref === undefined && !focus.node) throw new Error(`Nothing has focus in tab ${tab.id}, so there is nowhere to type. Click a field first, by ref or point, or use keys for canvas apps that read key presses.`);
    const ask = unapproved(focus, hosts, "Focus");
    if (ask) return { ...(await reply(tab.id, "")), ask };
    const into = ref === undefined ? `${await named(tab.id, focus.node.backendNodeId, focus.node, focus.sessionId)}${foreign(focus)}` : `[${ref}]`;
    await guarded(tab.id, () => cdp(tab.id, "Input.insertText", { text }));
    return acted(tab.id, `Typed ${text.length} characters into ${into}`);
  },

  async keys({ tabId, ref, keys, hosts = [] }, caller) {
    const combos = typeof keys === "string" ? keys.trim().split(/\s+/).filter(Boolean) : [];
    if (!combos.length) throw new Error("keys needs key names, like \"Enter\" or \"Shift+Tab\".");
    const mac = (await chrome.runtime.getPlatformInfo()).os === "mac";
    const presses = combos.map(combo => parseCombo(combo, mac));
    const tab = await piTab(caller, tabId);
    let ask;
    await inFront(tab, async () => {
      await overlay(tab.id, "show", ref === undefined ? undefined : await reveal(tab.id, ref).catch(() => undefined));
      if (ref !== undefined) await node(tab.id, "DOM.focus", ref);
      for (const [index, press] of presses.entries()) {
        const url = unapproved(await focusIn(tab.id), hosts, "Focus");
        if (url && !index) return void (ask = url);
        if (url) throw new Error(`Pressed ${combos.slice(0, index).join(" ")}, then focus moved to content from ${hostOf(url) ?? url}, so ${combos.slice(index).join(" ")} was not pressed. Use keys again for the rest; the user is asked about ${hostOf(url)} first.`);
        await guarded(tab.id, () => pressKeys(tab.id, press));
      }
    });
    if (ask) return { ...(await reply(tab.id, "")), ask };
    return acted(tab.id, `Pressed ${combos.join(" ")}`);
  },

  async scroll({ tabId, ref }, caller) {
    const tab = await piTab(caller, tabId);
    await overlay(tab.id, "show", await reveal(tab.id, ref));
    return acted(tab.id, `Scrolled [${ref}] into view`);
  },

  async screenshot({ tabId }, caller) {
    const tab = await piTab(caller, tabId);
    const { data, shot } = await inFront(tab, async () => {
      const { cssVisualViewport: css, visualViewport: device } = await cdp(tab.id, "Page.getLayoutMetrics");
      const fit = Math.min(1, SCREENSHOT_EDGE / Math.max(css.clientWidth, css.clientHeight), Math.sqrt(SCREENSHOT_AREA / (css.clientWidth * css.clientHeight)));
      const width = Math.round(css.clientWidth * fit);
      const height = Math.round(css.clientHeight * fit);
      const clip = { x: css.pageX, y: css.pageY, width: css.clientWidth, height: css.clientHeight, scale: width / device.clientWidth };
      await overlay(tab.id, "conceal");
      const { data } = await cdp(tab.id, "Page.captureScreenshot", { format: "jpeg", quality: SCREENSHOT_QUALITY, clip }).finally(() => overlay(tab.id, "show"));
      return { data, shot: { width, height, cssWidth: css.clientWidth, cssHeight: css.clientHeight } };
    });
    shots.set(tab.id, shot);
    return { ...(await reply(tab.id, `Screenshot of tab ${tab.id}, ${shot.width}x${shot.height} pixels.`)), data };
  },

  async console({ tabId }, caller) {
    const tab = await piTab(caller, tabId);
    const log = await logOf(tab.id);
    if (!log.listening) {
      for (const domain of ["Runtime", "Log"]) await cdp(tab.id, `${domain}.enable`);
      log.listening = true;
    }
    return reply(tab.id, listing(tab.id, "console messages", log.console));
  },

  async network({ tabId }, caller) {
    const tab = await piTab(caller, tabId);
    const log = await logOf(tab.id);
    const lines = log.network.map(({ method, status, type, url }) => `${method} ${status ?? "pending"} ${type} ${url}`);
    return reply(tab.id, listing(tab.id, "requests", lines, log.partial ? "since the debugger attached; reload the page to see all requests" : undefined));
  },

  async eval({ tabId, code, host }, caller) {
    if (typeof code !== "string" || !code.trim()) throw new Error("eval needs code.");
    const tab = await piTab(caller, tabId);
    if (host !== undefined && hostOf(tab.url) !== host) throw new Error(`Tab ${tab.id} is no longer on ${host}, so the code was not run.`);
    const objectGroup = "pi-eval";
    try {
      let { result, exceptionDetails } = await guarded(tab.id, () => cdp(tab.id, "Runtime.evaluate", {
        expression: code, replMode: true, objectGroup, awaitPromise: true, timeout: EVAL_TIMEOUT_MS,
      }));
      if (!exceptionDetails && result.objectId) {
        ({ result, exceptionDetails } = await guarded(tab.id, () => cdp(tab.id, "Runtime.callFunctionOn", {
          objectId: result.objectId, functionDeclaration: "function () { return this; }", returnByValue: true, awaitPromise: true,
        })));
      }
      return await reply(tab.id, exceptionDetails ? `Uncaught: ${exceptionDetails.exception?.description ?? exceptionDetails.text}` : render(result));
    } finally {
      chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  },

  async status(_, caller) {
    const group = await groupOf(caller);
    return { browser: browserName(), group: group && { title: group.title, color: group.color } };
  },

  async idle(_, caller) {
    await Promise.all((await piTabs(caller)).filter(tab => attached.has(tab.id)).map(tab => overlay(tab.id, "hide")));
    return {};
  },
};

const KEYS = {
  Enter: [13, "Enter", "\r"], Tab: [9, "Tab"], Escape: [27, "Escape"], Backspace: [8, "Backspace"], Delete: [46, "Delete"],
  Space: [32, "Space", " "], ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], ArrowLeft: [37, "ArrowLeft"],
  ArrowRight: [39, "ArrowRight"], Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"],
};
const MODIFIERS = { Alt: [1, 18], Control: [2, 17], Meta: [4, 91], Shift: [8, 16] };
const BUTTONS = { left: 1, right: 2 };
const CLICKED = ["Clicked", "Double-clicked", "Triple-clicked"];
const MAC_COMMANDS = { Meta: { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" }, "Meta+Shift": { z: "redo" } };

const attached = new Map();
const refs = new Map();
const shots = new Map();
const frameSessions = new Map();
const autoAttached = new Map();
const logs = new Map();
const dialogs = new Map();
const current = new Map();
const links = new Map();
const queues = new Map();
let host;
let hostVersion;
let retry;
let delay = RECONNECT_MS;

const session = {
  open(peer) {
    links.set(peer.id, peer);
    chrome.action.setTitle({ title: "Pi Browser: connected" });
    readopt(peer.id).catch(() => {});
  },
  async message(peer, { id, method, params, name }) {
    let reply;
    try {
      await queues.get("groups");
      if (method !== "status" && method !== "hello") await allowed();
      if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown browser action: ${method}`);
      reply = { id, result: await handlers[method](params ?? {}, { id: peer.id, name }) };
    } catch (error) {
      reply = { id, error: error?.message ?? String(error) };
    }
    if (links.get(peer.id) === peer) peer.send(reply);
  },
  async close(peer) {
    if (links.get(peer.id) !== peer) return;
    links.delete(peer.id);
    if (!links.size) chrome.action.setTitle({ title: "Pi Browser: not connected" });
    const tabs = await piTabs({ id: peer.id });
    if (links.has(peer.id)) return;
    await end(peer.id);
    if (links.has(peer.id)) return;
    await Promise.all(tabs.map(tab => detach(tab.id)));
  },
};

function connect() {
  if (host) return;
  clearTimeout(retry);
  const port = host = chrome.runtime.connectNative(HOST);
  const peers = new Map();
  hostVersion = undefined;
  port.onMessage.addListener(({ session: id, event, message, version }) => {
    delay = RECONNECT_MS;
    const peer = peers.get(id);
    if (event === "hello") {
      hostVersion = version;
      if (!links.size) chrome.action.setTitle({ title: "Pi Browser: not connected" });
    }
    else if (event === "connected") {
      const next = { id, send: reply => port.postMessage({ session: id, message: reply }) };
      peers.set(id, next);
      session.open(next);
    } else if (event === "disconnected" && peer) {
      peers.delete(id);
      session.close(peer);
    } else if (peer && message) session.message(peer, message);
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    for (const peer of peers.values()) session.close(peer);
    host = undefined;
    if (error) {
      chrome.action.setTitle({ title: `Pi Browser: cannot start pi's native host (${error}). Use the browser in pi once to install it, then click this icon to retry. Snap and Flatpak browsers cannot run it.` });
    }
    retry = setTimeout(connect, delay);
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  });
}

function serial(key, run) {
  const result = (queues.get(key) ?? Promise.resolve()).then(run);
  queues.set(key, result.catch(() => {}));
  return result;
}

async function groups() {
  return (await chrome.storage.session.get("groups")).groups ?? {};
}

async function groupOf({ id, name }) {
  const groupId = (await groups())[id];
  const group = groupId === undefined ? undefined : await chrome.tabGroups.get(groupId).catch(() => undefined);
  if (group && name && group.title !== `pi · ${name}` && (await groups())[id] === group.id && links.has(id)) return chrome.tabGroups.update(group.id, { title: `pi · ${name}` });
  return group;
}

async function liveColors(owned) {
  return (await chrome.tabGroups.query({})).filter(group => Object.values(owned).includes(group.id)).map(group => group.color);
}

function freeColor(used) {
  return COLORS.find(color => !used.includes(color)) ?? COLORS[used.length % COLORS.length];
}

function end(id) {
  return serial("groups", async () => {
    if (links.has(id)) return;
    const { [id]: groupId, ...owned } = await groups();
    const group = groupId === undefined ? undefined : await chrome.tabGroups.get(groupId).catch(() => undefined);
    const { ended = {} } = await chrome.storage.session.get("ended");
    await chrome.storage.session.set({ groups: owned, ended: group ? { ...ended, [id]: groupId } : ended });
    if (group) await chrome.tabGroups.update(groupId, { title: `${group.title} (ended)` });
  });
}

function readopt(id) {
  return serial("groups", async () => {
    const { ended = {} } = await chrome.storage.session.get("ended");
    if (!links.has(id) || ended[id] === undefined) return;
    const { [id]: groupId, ...rest } = ended;
    const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
    if (!group) return chrome.storage.session.set({ ended: rest });
    const owned = await groups();
    const used = await liveColors(owned);
    await chrome.tabGroups.update(groupId, { title: group.title.replace(/ \(ended\)$/, ""), color: used.includes(group.color) ? freeColor(used) : group.color });
    await chrome.storage.session.set({ ended: rest, groups: { ...owned, [id]: groupId } });
  });
}

async function piTabs(caller) {
  const group = await groupOf(caller);
  return group ? chrome.tabs.query({ groupId: group.id }) : [];
}

async function piTab(caller, tabId) {
  const tabs = await piTabs(caller);
  const tab = tabId === undefined ? tabs.find(tab => tab.id === current.get(caller.id)) ?? tabs.at(-1) : tabs.find(tab => tab.id === tabId);
  if (!tab) throw new Error(tabId === undefined ? "No pi tabs are open. Use navigate first." : `Tab ${tabId} is not in your group.`);
  if (attached.has(tab.id) && attached.get(tab.id) !== tab.groupId) await detach(tab.id);
  current.set(caller.id, tab.id);
  return tab;
}

function openTab(caller) {
  return serial("groups", async () => {
    if (!links.has(caller.id)) throw new Error("This pi session disconnected from the browser.");
    const group = await groupOf(caller);
    const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: group?.windowId });
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], groupId: group?.id });
    if (!group) {
      const owned = await groups();
      await chrome.tabGroups.update(groupId, { title: `pi · ${caller.name}`, color: freeColor(await liveColors(owned)) });
      await chrome.storage.session.set({ groups: { ...owned, [caller.id]: groupId } });
    }
    current.set(caller.id, tab.id);
    return tab;
  });
}

async function allowed() {
  if ((await chrome.storage.session.get("canceled")).canceled) {
    throw new Error("Debugging was canceled in Chrome. Click the Pi Browser toolbar icon to allow it again.");
  }
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  let groupId;
  await unblocked(tabId, async () => {
    await allowed();
    ({ groupId } = await chrome.tabs.get(tabId));
    if (!Object.values(await groups()).includes(groupId)) throw new Error(`Tab ${tabId} is not in a live pi group.`);
    await chrome.debugger.attach({ tabId }, "1.3").catch(error => { if (!/already attached/i.test(error.message)) throw error; });
    logs.set(tabId, { console: [], network: [], requests: new Map(), partial: true });
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  });
  attached.set(tabId, groupId);
}

async function unblocked(tabId, run) {
  for (let tries = 0; ; tries++) {
    try {
      return await run();
    } catch (error) {
      if (!/URL of different extension/.test(error.message)) throw error;
      if (tries === STRIP_TRIES) {
        throw new Error(`Another extension, likely a password manager such as LastPass, has a frame in tab ${tabId} that Pi Browser could not remove, and Chrome does not let Pi Browser control a tab that holds another extension's frame. Ask the user to turn that extension off for this site, or to use a Chrome profile without it.`);
      }
      await strip(tabId);
      await new Promise(resolve => setTimeout(resolve, STRIP_WAIT_MS * (tries + 1)));
    }
  }
}

function strip(tabId) {
  return chrome.scripting.executeScript({ target: { tabId, allFrames: true }, injectImmediately: true, args: [chrome.runtime.id], func: own => {
    const roots = [document];
    for (const root of roots) {
      for (const element of root.querySelectorAll("*")) {
        if (element instanceof HTMLIFrameElement && /^chrome-extension:/.test(element.src) && new URL(element.src).host !== own) element.remove();
        const shadow = element instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(element);
        if (shadow) roots.push(shadow);
      }
    }
  } }).catch(() => {});
}

async function cdp(tabId, method, params, sessionId) {
  if (dialogs.has(tabId)) throw dialogError(dialogs.get(tabId));
  await attach(tabId);
  return unblocked(tabId, () => chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params));
}

async function logOf(tabId) {
  await attach(tabId);
  return logs.get(tabId);
}

function clip(text) {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}… (cut)` : text;
}

function push(list, entry) {
  list.push(entry);
  return list.length > LOG_LIMIT ? list.shift() : undefined;
}

function remote(value) {
  if (value.type === "string") return value.value;
  if (value.unserializableValue) return value.unserializableValue;
  if (value.value !== undefined) return JSON.stringify(value.value);
  return value.description ?? value.type;
}

function render(result) {
  return result.value !== undefined && result.type !== "string" ? JSON.stringify(result.value, null, 2) : remote(result);
}

function listing(tabId, what, lines, since = "since its page loaded") {
  const head = lines.length
    ? `${lines.length} ${what} in tab ${tabId} ${since}, oldest first${lines.length === LOG_LIMIT ? `; only the last ${LOG_LIMIT} are kept` : ""}:`
    : `No ${what} in tab ${tabId} ${since}.`;
  return [head, ...lines].join("\n");
}

function record(tabId, method, params) {
  const log = logs.get(tabId);
  if (!log) return;
  if (method === "Runtime.consoleAPICalled") {
    push(log.console, clip(`[${params.type}] ${params.args.map(remote).join(" ")}`));
    release(tabId);
  } else if (method === "Runtime.exceptionThrown") {
    push(log.console, clip(`[exception] ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`));
    release(tabId);
  } else if (method === "Log.entryAdded" && params.entry.level !== "verbose") {
    push(log.console, clip(`[${params.entry.level}] ${params.entry.text}${params.entry.url ? ` <${params.entry.url}>` : ""}`));
  } else if (method === "Network.requestWillBeSent") {
    const redirected = log.requests.get(params.requestId);
    if (redirected && params.redirectResponse) redirected.status = params.redirectResponse.status;
    const request = { id: params.requestId, loaderId: params.loaderId, method: params.request.method, url: clip(params.request.url), type: params.type ?? "Other" };
    log.requests.set(request.id, request);
    const dropped = push(log.network, request);
    if (dropped && log.requests.get(dropped.id) === dropped) log.requests.delete(dropped.id);
  } else if (method === "Network.responseReceived") {
    const request = log.requests.get(params.requestId);
    if (request) Object.assign(request, { status: params.response.status, type: params.type });
  } else if (method === "Network.loadingFailed") {
    const request = log.requests.get(params.requestId);
    if (request) request.status = params.canceled ? "canceled" : params.blockedReason ? `blocked (${params.blockedReason})` : `failed (${params.errorText})`;
  } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
    log.partial = false;
    log.console = [];
    log.network = log.network.filter(request => request.loaderId === params.frame.loaderId);
    log.requests = new Map(log.network.map(request => [request.id, request]));
  }
}

function release(tabId) {
  chrome.debugger.sendCommand({ tabId }, "Runtime.releaseObjectGroup", { objectGroup: "console" }).catch(() => {});
}

function hostOf(url) {
  try { return /^https?:$/.test(new URL(url).protocol) ? new URL(url).hostname : undefined; } catch { return undefined; }
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
    if (/no node|layout object|detached/i.test(error.message)) throw new Error(`Ref [${ref}] is no longer on the page. Use read for fresh refs.`);
    throw error;
  }
}

async function reveal(tabId, ref) {
  await node(tabId, "DOM.scrollIntoViewIfNeeded", ref);
  return center(tabId, ref);
}

async function center(tabId, ref) {
  const { quads } = await node(tabId, "DOM.getContentQuads", ref);
  if (!quads?.length) return undefined;
  const [quad] = quads;
  return { x: Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4), y: Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4) };
}

function spot(tabId, point) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) throw new Error("A point is [x, y] in pixels of the tab's last screenshot.");
  const shot = shots.get(tabId);
  if (!shot) throw new Error(`Tab ${tabId} has no screenshot to take a point from. Use screenshot first, then give points in its pixels.`);
  const [x, y] = point;
  if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) throw new Error(`Point (${x}, ${y}) is outside tab ${tabId}'s last screenshot, which is ${shot.width}x${shot.height} pixels.`);
  return { x: Math.min(Math.round(x * shot.cssWidth / shot.width), shot.cssWidth - 1), y: Math.min(Math.round(y * shot.cssHeight / shot.height), shot.cssHeight - 1) };
}

async function press(tabId, at, button, count, check) {
  const mouse = params => cdp(tabId, "Input.dispatchMouseEvent", { ...at, button, ...params });
  await mouse({ type: "mouseMoved", button: "none" });
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    await check?.(clickCount - 1);
    await mouse({ type: "mousePressed", clickCount, buttons: BUTTONS[button] });
    await mouse({ type: "mouseReleased", clickCount, buttons: 0 });
  }
}

function inFront(tab, run) {
  return serial(`window ${tab.windowId}`, async () => {
    await chrome.tabs.update(tab.id, { active: true });
    const { result } = await cdp(tab.id, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });
    if (result.value !== "visible") throw new Error(`Tab ${tab.id}'s window is hidden (minimized, fully covered, on another desktop, or the screen is locked), and Chrome drops clicks and key presses there and may not render the page. Ask the user to bring that window into view.`);
    return run();
  });
}

async function located(tabId, at) {
  const { cssVisualViewport: { pageX, pageY } } = await cdp(tabId, "Page.getLayoutMetrics");
  return cdp(tabId, "DOM.getNodeForLocation", { x: Math.round(at.x + pageX), y: Math.round(at.y + pageY) });
}

async function uncovered(tabId, ref, at) {
  const hit = await located(tabId, at).catch(() => undefined);
  if (!hit) throw new Error(`Ref [${ref}] has no point on the page to click.`);
  const frameId = [...refs.get(tabId) ?? []].find(([, found]) => found.has(ref))?.[0];
  if (hit.frameId === frameId) {
    const objectGroup = "pi-hit";
    try {
      const resolve = async backendNodeId => (await cdp(tabId, "DOM.resolveNode", { backendNodeId, objectGroup })).object.objectId;
      const { result } = await cdp(tabId, "Runtime.callFunctionOn", {
        objectId: await resolve(ref), arguments: [{ objectId: await resolve(hit.backendNodeId) }], returnByValue: true,
        functionDeclaration: "function (hit) { if (this.getRootNode().host === hit) return true; for (let node = hit; node; node = node.assignedSlot ?? node.parentNode ?? node.host) if (node === this || [...this.labels ?? []].includes(node)) return true; return false; }",
      });
      if (result.value) return;
    } finally {
      chrome.debugger.sendCommand({ tabId }, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  }
  throw new Error(`Ref [${ref}] is covered at its center by ${await tag(tabId, hit.backendNodeId)}, so a click there would miss it. Close or move what covers it, then read for fresh refs.`);
}

async function frameAt(tabId, at, where) {
  let sessionId, main, { x, y } = at;
  for (;;) {
    const { cssVisualViewport: { pageX, pageY } } = await cdp(tabId, "Page.getLayoutMetrics", undefined, sessionId);
    const hit = await cdp(tabId, "DOM.getNodeForLocation", { x: Math.round(x + pageX), y: Math.round(y + pageY) }, sessionId).catch(() => undefined);
    if (!hit) throw new Error(`${where} has nothing on the page under it in tab ${tabId}.`);
    const { node } = await cdp(tabId, "DOM.describeNode", { backendNodeId: hit.backendNodeId }, sessionId);
    const { frameTree } = await cdp(tabId, "Page.getFrameTree", undefined, sessionId);
    const place = placeIn(frameTree, hit.frameId);
    main ??= placeIn(frameTree, frameTree.frame.id);
    if (!node.frameId || node.frameId === hit.frameId || node.contentDocument) return { ...place, main, sessionId, hit, node };
    const { model: { content } } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: hit.backendNodeId }, sessionId);
    x -= content[0];
    y -= content[1];
    sessionId = await child(tabId, sessionId, node, where);
  }
}

async function focusIn(tabId) {
  const objectGroup = "pi-focus";
  const sessions = new Set([undefined]);
  let sessionId, frameId, main;
  try {
    for (;;) {
      const { frameTree } = await cdp(tabId, "Page.getFrameTree", undefined, sessionId);
      frameId ??= frameTree.frame.id;
      const place = placeIn(frameTree, frameId);
      main ??= place;
      const { executionContextId: contextId } = await cdp(tabId, "Page.createIsolatedWorld", { frameId, worldName: OVERLAY_WORLD }, sessionId);
      let { result } = await cdp(tabId, "Runtime.evaluate", { contextId, objectGroup, expression: "document.activeElement" }, sessionId);
      let node;
      while (result.objectId) {
        ({ node } = await cdp(tabId, "DOM.describeNode", { objectId: result.objectId }, sessionId));
        const root = node.shadowRoots?.find(root => root.shadowRootType !== "user-agent");
        if (!root) break;
        const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId: root.backendNodeId, executionContextId: contextId, objectGroup }, sessionId);
        const inner = (await cdp(tabId, "Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { return this.activeElement; }" }, sessionId)).result;
        if (!inner.objectId) break;
        result = inner;
      }
      if (!node) return { ...place, main, sessionId };
      if (!node.frameId) {
        const { result: { value } } = await cdp(tabId, "Runtime.callFunctionOn", { objectId: result.objectId, returnByValue: true, functionDeclaration: FOCUSED }, sessionId);
        return { ...place, main, sessionId, node: value ? node : undefined };
      }
      frameId = node.frameId;
      if (!node.contentDocument) sessions.add(sessionId = await child(tabId, sessionId, node, "Focus"));
    }
  } finally {
    for (const sessionId of sessions) chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
}

function placeIn(frameTree, frameId) {
  for (const frame of (lineage(frameTree, frameId) ?? []).toReversed()) {
    const url = frame.url.replace(/^blob:/i, "");
    if (/^https?:/i.test(url)) return { url, site: frame.domainAndRegistry || hostOf(url) };
    if (!/^(about|data):/i.test(url)) return { url };
  }
  return { url: frameTree.frame.url };
}

function lineage({ frame, childFrames = [] }, frameId) {
  if (frame.id === frameId) return [frame];
  for (const tree of childFrames) {
    const path = lineage(tree, frameId);
    if (path) return [frame, ...path];
  }
}

async function child(tabId, sessionId, owner, where) {
  const sessions = frameSessions.get(tabId) ?? frameSessions.set(tabId, new Map()).get(tabId);
  const watched = autoAttached.get(tabId) ?? autoAttached.set(tabId, new Set()).get(tabId);
  if (!watched.has(sessionId)) {
    await cdp(tabId, "Target.setAutoAttach", AUTO_ATTACH, sessionId);
    watched.add(sessionId);
  }
  if (!sessions.has(owner.frameId)) throw new Error(`${where} is inside ${label(owner)}, a frame Pi Browser cannot reach; it may still be loading, so try again in a moment.`);
  return sessions.get(owner.frameId);
}

function unapproved({ url = "", site, main }, hosts, where) {
  const host = hostOf(url);
  const scheme = /^[\w-]+:/.exec(url)?.[0] ?? "non-web";
  if (!host) throw new Error(`${where} is in a frame showing ${/^[aeiou]/.test(scheme) ? "an" : "a"} ${scheme} page, and Pi Browser acts only in http and https pages, so nothing was done.`);
  if (!hosts.includes(hostOf(main.url))) return main.url;
  return site === main.site || hosts.includes(host) ? undefined : url;
}

function foreign({ url, site, main }) {
  return site === main.site ? "" : ` in a frame from ${hostOf(url)}`;
}

async function named(tabId, backendNodeId, node, sessionId) {
  const { nodes } = await cdp(tabId, "Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: true }, sessionId).catch(() => ({ nodes: [] }));
  const byId = new Map(nodes.map(ax => [ax.nodeId, ax]));
  for (let ax = nodes.find(ax => ax.backendDOMNodeId === backendNodeId); ax; ax = byId.get(ax.parentId)) {
    const role = ax.role?.value;
    const name = String(ax.name?.value ?? "").trim();
    if (!ax.ignored && role && role !== "StaticText" && !SKIP.has(role)) return `${role}${name ? ` ${JSON.stringify(name)}` : ""}`;
  }
  return label(node);
}

async function tag(tabId, backendNodeId) {
  return label((await cdp(tabId, "DOM.describeNode", { backendNodeId })).node);
}

function label({ localName, attributes = [] }) {
  const id = attributes.findIndex((name, index) => index % 2 === 0 && name === "id");
  return `<${localName}${id < 0 ? "" : ` id="${attributes[id + 1]}"`}>`;
}

function overlay(tabId, command, at) {
  const send = (method, params) => attached.has(tabId) && !dialogs.has(tabId)
    ? chrome.debugger.sendCommand({ tabId }, method, params)
    : Promise.reject(new Error(`Tab ${tabId} was released.`));
  const run = async () => {
    await attach(tabId);
    const { groupId } = await chrome.tabs.get(tabId);
    const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
    const { frameTree } = await send("Page.getFrameTree");
    const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: OVERLAY_WORLD });
    await send("Runtime.addBinding", { name: STOP_BINDING, executionContextName: OVERLAY_WORLD });
    const args = JSON.stringify([command, at ?? null, { move: CURSOR_MOVE_MS, idle: OVERLAY_IDLE_MS, binding: STOP_BINDING, label: `Stop ${group?.title ?? "pi"}` }]);
    await send("Runtime.evaluate", { contextId: executionContextId, expression: `(${paint})(...${args})`, awaitPromise: true });
  };
  const wait = new Promise(resolve => setTimeout(resolve, OVERLAY_WAIT_MS));
  return Promise.race([run().catch(() => {}), wait]);
}

function paint(command, at, { move, idle, binding, label }) {
  let ui = globalThis.piOverlay;
  if (!ui?.host.isConnected) {
    if (command === "hide" || command === "conceal") return;
    ui = globalThis.piOverlay = build();
  }
  clearTimeout(ui.timer);
  if (command === "hide") return ui.remove();
  ui.timer = setTimeout(ui.remove, idle);
  ui.frame.classList.toggle("concealed", command === "conceal");
  ui.stop.style.pointerEvents = command === "aim" ? "none" : "";
  ui.stop.textContent = label;
  const moved = at && (at.x !== ui.x || at.y !== ui.y);
  if (moved) {
    ui.x = at.x;
    ui.y = at.y;
    ui.cursor.style.transform = `translate(${at.x}px, ${at.y}px)`;
  }
  const arrived = moved && !document.hidden ? new Promise(resolve => setTimeout(resolve, move)) : Promise.resolve();
  return command === "aim" ? arrived.then(ui.ripple) : arrived;

  function build() {
    const host = document.createElement("pi-overlay");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important;";
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .frame { opacity: 0; transition: opacity 300ms; }
      .frame.on { opacity: 1; }
      .frame.concealed { display: none; }
      .glow { position: fixed; inset: 0; animation: pulse 2s ease-in-out infinite;
        box-shadow: inset 0 0 15px rgba(59, 130, 246, 0.7), inset 0 0 25px rgba(59, 130, 246, 0.5), inset 0 0 35px rgba(59, 130, 246, 0.2); }
      .cursor { position: fixed; top: 0; left: 0; transition: transform ${move}ms cubic-bezier(0.2, 0, 0, 1); }
      .ring, .dot, .ripple { position: absolute; box-sizing: border-box; border-radius: 50%; }
      .ring { width: 28px; height: 28px; margin: -14px; border: 2px solid rgba(59, 130, 246, 0.55); background: rgba(59, 130, 246, 0.12);
        box-shadow: 0 0 12px rgba(59, 130, 246, 0.6); }
      .dot { width: 10px; height: 10px; margin: -5px; background: #3b82f6; box-shadow: 0 0 0 2px #fff, 0 0 8px rgba(59, 130, 246, 0.9); }
      .ripple { width: 28px; height: 28px; margin: -14px; border: 2px solid #3b82f6; animation: ripple 500ms ease-out forwards; }
      button { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 10px;
        padding: 10px 16px; border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 12px; background: #fff; color: #111827;
        font: 600 14px/1 system-ui, sans-serif; cursor: pointer; pointer-events: auto;
        box-shadow: 0 4px 14px rgba(59, 130, 246, 0.25), 0 20px 40px rgba(59, 130, 246, 0.15); }
      button:hover { background: #eff6ff; }
      button::before { content: ""; width: 10px; height: 10px; border-radius: 2px; background: #3b82f6; }
      @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
      @keyframes ripple { to { transform: scale(2.4); opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { .glow { animation: none; } .ripple { display: none; } .cursor { transition: none; } }
    `);
    root.adoptedStyleSheets = [sheet];
    const make = (tag, className, parent) => parent.appendChild(Object.assign(document.createElement(tag), { className }));
    const frame = make("div", "frame", root);
    make("div", "glow", frame);
    const cursor = make("div", "cursor", frame);
    make("div", "ring", cursor);
    make("div", "dot", cursor);
    const stop = make("button", "", frame);
    stop.tabIndex = -1;
    const x = innerWidth / 2;
    const y = innerHeight / 2;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    document.documentElement.appendChild(host);
    host.getBoundingClientRect();
    frame.classList.add("on");
    const self = {
      host, frame, cursor, stop, x, y,
      ripple: () => make("div", "ripple", cursor).addEventListener("animationend", event => event.target.remove()),
      remove: () => {
        clearTimeout(self.timer);
        if (globalThis.piOverlay === self) delete globalThis.piOverlay;
        frame.classList.remove("on");
        setTimeout(() => host.remove(), 300);
      },
    };
    stop.addEventListener("click", event => {
      if (!event.isTrusted) return;
      globalThis[binding]?.("");
      self.remove();
    });
    return self;
  }
}

async function reply(tabId, text) {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url || tab.pendingUrl || "", text };
}

function acted(tabId, what) {
  return reply(tabId, `${what} in tab ${tabId}.`);
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

function browserName() {
  const brands = navigator.userAgentData?.brands ?? [];
  const brand = brands.find(({ brand }) => !/not.a.brand|^chromium$/i.test(brand)) ?? brands.find(({ brand }) => brand === "Chromium");
  return brand ? `${brand.brand} ${brand.version}` : "an unknown browser";
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

function forget(tabId) {
  attached.delete(tabId);
  refs.delete(tabId);
  shots.delete(tabId);
  frameSessions.delete(tabId);
  autoAttached.delete(tabId);
  logs.delete(tabId);
  dialogs.delete(tabId);
}

async function detach(tabId) {
  if (attached.has(tabId)) await overlay(tabId, "hide");
  forget(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function stop(tabId) {
  const { groupId } = await chrome.tabs.get(tabId);
  const [id] = Object.entries(await groups()).find(([, group]) => group === groupId) ?? [];
  links.get(id)?.send({ event: "stop" });
}

async function detachAll() {
  await Promise.all([...attached.keys()].map(tabId => overlay(tabId, "hide")));
  attached.clear();
  refs.clear();
  shots.clear();
  frameSessions.clear();
  autoAttached.clear();
  logs.clear();
  dialogs.clear();
  for (const target of await chrome.debugger.getTargets()) {
    if (target.attached && target.tabId !== undefined) chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
  }
}

chrome.debugger.onEvent.addListener(({ tabId, sessionId }, method, params) => {
  if (method === "Target.attachedToTarget") frameSessions.get(tabId)?.set(params.targetInfo.targetId, params.sessionId);
  else if (method === "Target.detachedFromTarget") {
    autoAttached.get(tabId)?.delete(params.sessionId);
    if (frameSessions.get(tabId)?.get(params.targetId) === params.sessionId) frameSessions.get(tabId).delete(params.targetId);
  }
  if (sessionId) return;
  record(tabId, method, params);
  if (method === "Page.frameNavigated" && !params.frame.parentId) refs.delete(tabId);
  else if (method === "Page.frameNavigated") refs.get(tabId)?.delete(params.frame.id);
  else if (method === "Page.frameDetached") refs.get(tabId)?.delete(params.frameId);
  else if (method === "Page.javascriptDialogOpening") dialogs.set(tabId, params.type);
  else if (method === "Page.javascriptDialogClosed") dialogs.delete(tabId);
  else if (method === "Runtime.bindingCalled" && params.name === STOP_BINDING) stop(tabId).catch(() => {});
});
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  forget(tabId);
  if (reason !== "canceled_by_user") return;
  chrome.storage.session.set({ canceled: true });
  detachAll();
});
chrome.tabs.onUpdated.addListener((tabId, { groupId }) => {
  if (groupId !== undefined && attached.has(tabId) && attached.get(tabId) !== groupId) detach(tabId);
});
chrome.runtime.onStartup.addListener(connect);
chrome.action.onClicked.addListener(() => chrome.storage.session.remove("canceled").then(() => {
  delay = RECONNECT_MS;
  if (host && !links.size) {
    host.disconnect();
    host = undefined;
  }
  connect();
}));
connect();
