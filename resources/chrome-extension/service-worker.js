const PORTS = Array.from({ length: 9 }, (_, index) => 17341 + index);
const attachedTabs = new Set();
const consoleEntries = new Map();
const networkEntries = new Map();
const networkRequests = new Map();
const controlledGroups = new Map();
let socket = null;
let connectedPort = 0;
let reconnectTimer = 0;
let keepAliveTimer = 0;
let activeTabId = 0;
let connecting = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendStatus() {
  chrome.runtime.sendMessage({
    type: "lumen-bridge-status",
    connected: socket?.readyState === WebSocket.OPEN,
    port: connectedPort
  }).catch(() => undefined);
}

function scheduleReconnect(delay = 1200) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = 0;
}

async function restoreControlGroup(tabId) {
  const group = controlledGroups.get(tabId);
  if (!group) return;
  try {
    if (group.previousGroupId >= 0) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: group.previousGroupId });
    } else {
      await chrome.tabs.ungroup(tabId);
    }
  } catch {
    try {
      await chrome.tabs.ungroup(tabId);
    } catch {}
  }
  controlledGroups.delete(tabId);
}

async function releaseControlledTabs() {
  const tabIds = [...attachedTabs];
  activeTabId = 0;
  for (const tabId of tabIds) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
    await restoreControlGroup(tabId);
    attachedTabs.delete(tabId);
    consoleEntries.delete(tabId);
    networkEntries.delete(tabId);
  }
  for (const key of networkRequests.keys()) {
    if (tabIds.some((tabId) => key.startsWith(`${tabId}:`))) networkRequests.delete(key);
  }
}

function startKeepAlive(candidate) {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (candidate.readyState !== WebSocket.OPEN) {
      stopKeepAlive();
      return;
    }
    candidate.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
  }, 20_000);
}

async function connect() {
  if (connecting || (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState))) return;
  connecting = true;
  let port = 0;
  for (const candidatePort of PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${candidatePort}/health`, { cache: "no-store" });
      if (response.ok) {
        port = candidatePort;
        break;
      }
    } catch {}
  }
  connecting = false;
  if (!port) {
    connectedPort = 0;
    sendStatus();
    scheduleReconnect(30_000);
    return;
  }
  const candidate = new WebSocket(`ws://127.0.0.1:${port}/chrome-extension`);
  socket = candidate;
  candidate.onopen = () => {
    connectedPort = port;
      candidate.send(JSON.stringify({
        type: "hello",
        protocol: "lumen.chrome.v1",
        version: chrome.runtime.getManifest().version,
        features: ["health-probe", "native-tab-group", "picture-in-picture-source", "detach-on-disconnect"]
      }));
    startKeepAlive(candidate);
    sendStatus();
  };
  candidate.onerror = () => candidate.close();
  candidate.onclose = () => {
    if (socket !== candidate) return;
    stopKeepAlive();
    socket = null;
    connectedPort = 0;
    sendStatus();
    void releaseControlledTabs();
    scheduleReconnect();
  };
  candidate.onmessage = async (event) => {
    let request;
    try {
      request = JSON.parse(String(event.data));
      const result = await dispatch(request.method, request.params || {});
      candidate.send(JSON.stringify({ id: request.id, result }));
    } catch (error) {
      candidate.send(JSON.stringify({
        id: request?.id,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  };
}

async function currentTab() {
  if (activeTabId) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      if (tab?.id) return tab;
    } catch {
      activeTabId = 0;
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active Chrome tab is available.");
  activeTabId = tab.id;
  return tab;
}

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  await showControlGroup(tabId);
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    await restoreControlGroup(tabId);
    throw error;
  }
  attachedTabs.add(tabId);
  await Promise.all([
    chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
    chrome.debugger.sendCommand({ tabId }, "Page.enable"),
    chrome.debugger.sendCommand({ tabId }, "Log.enable"),
    chrome.debugger.sendCommand({ tabId }, "Network.enable")
  ]);
}

async function showControlGroup(tabId) {
  if (controlledGroups.has(tabId)) return controlledGroups.get(tabId);
  const tab = await chrome.tabs.get(tabId);
  const previousGroupId = typeof tab.groupId === "number" ? tab.groupId : -1;
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  const group = await chrome.tabGroups.update(groupId, {
    title: "Lumen",
    color: "orange",
    collapsed: false
  });
  const state = {
    groupId,
    previousGroupId: previousGroupId === groupId ? -1 : previousGroupId,
    title: group?.title || "Lumen",
    color: group?.color || "orange"
  };
  controlledGroups.set(tabId, state);
  return state;
}

async function command(method, params = {}) {
  const tab = await currentTab();
  await attach(tab.id);
  return chrome.debugger.sendCommand({ tabId: tab.id }, method, params);
}

async function waitForComplete(tabId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(100);
  }
  throw new Error("Chrome page did not finish loading.");
}

async function windowDetails(windowId) {
  const current = await chrome.windows.get(windowId);
  return {
    left: current.left,
    top: current.top,
    width: current.width,
    height: current.height
  };
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Chrome evaluation failed.");
  }
  return response.result?.value;
}

async function dispatch(method, params) {
  if (method === "status") {
    const tab = await currentTab();
    return { connected: true, tabId: tab.id, url: tab.url || "", title: tab.title || "" };
  }
  if (method === "release") {
    await releaseControlledTabs();
    return { released: true };
  }
  if (method === "open") {
    const tab = await chrome.tabs.create({ url: String(params.url), active: true });
    if (!tab.id) throw new Error("Chrome did not create a tab.");
    activeTabId = tab.id;
    const loaded = await waitForComplete(tab.id);
    await attach(tab.id);
    const window = typeof loaded.windowId === "number"
      ? await windowDetails(loaded.windowId)
      : undefined;
    return {
      url: loaded.url || String(params.url),
      title: loaded.title || "",
      group: controlledGroups.get(tab.id),
      window
    };
  }
  if (method === "snapshot") {
    return evaluate(`(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const controls = Array.from(document.querySelectorAll(
        'a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]'
      )).filter(visible).slice(0, 36).map((el, index) => {
        const ref = String(index + 1);
        el.setAttribute("data-lumen-chrome-ref", ref);
        const value = "value" in el ? String(el.value || "").slice(0, 120) : "";
        return {
          ref,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || undefined,
          text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\\s+/g, " ").slice(0, 100),
          value: value || undefined,
          disabled: Boolean(el.disabled)
        };
      });
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || "").trim().replace(/\\n{3,}/g, "\\n\\n").slice(0, 2200),
        controls
      };
    })()`);
  }
  if (method === "click") {
    const ref = JSON.stringify(String(params.ref ?? ""));
    const clicked = await evaluate(`(() => {
      const el = document.querySelector('[data-lumen-chrome-ref="' + CSS.escape(${ref}) + '"]');
      if (!el) return false;
      el.scrollIntoView({block: "center", inline: "center"});
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Chrome control ref ${String(params.ref)} is stale. Take a new snapshot.`);
    return { clicked: String(params.ref) };
  }
  if (method === "type") {
    const ref = JSON.stringify(String(params.ref ?? ""));
    const text = JSON.stringify(String(params.text ?? ""));
    const submit = params.submit === true;
    const typed = await evaluate(`(() => {
      const el = document.querySelector('[data-lumen-chrome-ref="' + CSS.escape(${ref}) + '"]');
      if (!el) return false;
      el.focus();
      if ("value" in el) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
        setter ? setter.call(el, ${text}) : el.value = ${text};
      } else {
        el.textContent = ${text};
      }
      el.dispatchEvent(new Event("input", {bubbles: true}));
      el.dispatchEvent(new Event("change", {bubbles: true}));
      if (${submit}) el.form?.requestSubmit();
      return true;
    })()`);
    if (!typed) throw new Error(`Chrome control ref ${String(params.ref)} is stale. Take a new snapshot.`);
    return { typed: String(params.ref), submitted: submit };
  }
  if (method === "screenshot") {
    const result = await command("Page.captureScreenshot", { format: "png" });
    return { data: result.data };
  }
  if (method === "console") {
    const tab = await currentTab();
    await attach(tab.id);
    const entries = (consoleEntries.get(tab.id) || []).slice(-200);
    if (params.clear === true) consoleEntries.set(tab.id, []);
    return { count: entries.length, entries };
  }
  if (method === "network") {
    const tab = await currentTab();
    await attach(tab.id);
    const entries = (networkEntries.get(tab.id) || []).slice(-200);
    if (params.clear === true) networkEntries.set(tab.id, []);
    return { count: entries.length, entries };
  }
  throw new Error(`Unsupported Lumen browser command: ${String(method)}`);
}

function append(map, tabId, entry) {
  const entries = map.get(tabId) || [];
  entries.push(entry);
  if (entries.length > 500) entries.splice(0, entries.length - 500);
  map.set(tabId, entries);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  if (method === "Runtime.consoleAPICalled") {
    append(consoleEntries, source.tabId, {
      level: params.type,
      text: (params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 2000),
      timestamp: params.timestamp
    });
  } else if (method === "Log.entryAdded") {
    append(consoleEntries, source.tabId, {
      level: params.entry?.level || "log",
      text: String(params.entry?.text || "").slice(0, 2000),
      url: params.entry?.url,
      timestamp: params.entry?.timestamp
    });
  } else if (method === "Network.responseReceived") {
    const request = networkRequests.get(`${source.tabId}:${params.requestId}`);
    append(networkEntries, source.tabId, {
      method: request?.method,
      url: params.response?.url,
      status: params.response?.status,
      mimeType: params.response?.mimeType,
      type: params.type,
      timestamp: params.timestamp
    });
  } else if (method === "Network.requestWillBeSent") {
    networkRequests.set(`${source.tabId}:${params.requestId}`, {
      method: params.request?.method,
      url: params.request?.url
    });
    if (networkRequests.size > 1000) {
      const first = networkRequests.keys().next().value;
      if (first) networkRequests.delete(first);
    }
  }
});
chrome.debugger.onDetach.addListener((source) => {
  if (!source.tabId) return;
  attachedTabs.delete(source.tabId);
  void restoreControlGroup(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  controlledGroups.delete(tabId);
  consoleEntries.delete(tabId);
  networkEntries.delete(tabId);
  for (const key of networkRequests.keys()) {
    if (key.startsWith(`${tabId}:`)) networkRequests.delete(key);
  }
  if (activeTabId === tabId) activeTabId = 0;
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "lumen-get-status") return false;
  respond({ connected: socket?.readyState === WebSocket.OPEN, port: connectedPort });
  return false;
});

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.create("lumen-bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "lumen-bridge-reconnect") connect();
});

connect();
