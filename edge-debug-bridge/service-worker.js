const BRIDGE_URL = "http://127.0.0.1:19827";
const TARGET_ORIGIN = "https://sell.publish.tmall.com";
const TARGET_PATH = "/tmall/publish.htm";
const TARGET_ITEM_ID = "828872681901";
const POLL_ALARM = "tmall-local-bridge-poll";
const NETWORK_EVENT_LIMIT = 2_000;
const BODY_LIMIT_BYTES = 1_000_000;

let polling = false;
let pollScheduled = false;
const attachedTabs = new Set();
const deliveredNetworkEvents = new Map();
const inFlightCommandIds = new Set();
const requestUrls = new Map();
const responseMimeTypes = new Map();

function isTargetUrl(value) {
  try {
    const url = new URL(value);
    const isItemPage = (
      url.origin === TARGET_ORIGIN &&
      url.pathname === TARGET_PATH &&
      url.searchParams.get("id") === TARGET_ITEM_ID
    );
    const isLoginPage = url.origin === "https://login.taobao.com" && url.pathname === "/havanaone/login/login.htm";
    return isItemPage || isLoginPage;
  } catch {
    return false;
  }
}

function debuggerTarget(tabId) {
  return { tabId };
}

function redactHeaders(headers = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = /^(authorization|cookie|set-cookie|proxy-authorization|x-csrf-token|x-xsrf-token)$/i.test(name)
      ? "[REDACTED]"
      : value;
  }
  return result;
}

function capText(value) {
  if (typeof value !== "string") return value;
  return value.length > BODY_LIMIT_BYTES
    ? `${value.slice(0, BODY_LIMIT_BYTES)}\n[TRUNCATED]`
    : value;
}

function shouldIgnoreUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.protocol === "chrome-extension:" ||
      url.protocol === "data:" ||
      url.protocol === "blob:" ||
      url.hostname === "gm.mmstat.com"
    );
  } catch {
    return true;
  }
}

function shouldCaptureBody(value, mimeType = "") {
  if (shouldIgnoreUrl(value)) return false;
  if (/javascript|image|font|css|audio|video|octet-stream/i.test(mimeType)) return false;
  return true;
}

function rememberNetworkEvent(key) {
  const now = Date.now();
  if (deliveredNetworkEvents.has(key)) return false;
  deliveredNetworkEvents.set(key, now);
  if (deliveredNetworkEvents.size > NETWORK_EVENT_LIMIT) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [seenKey, seenAt] of deliveredNetworkEvents) {
      if (seenAt < cutoff || deliveredNetworkEvents.size > NETWORK_EVENT_LIMIT) {
        deliveredNetworkEvents.delete(seenKey);
      }
    }
  }
  return true;
}

async function bridgeFetch(path, options = {}) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    cache: "no-store",
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`Bridge ${path} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function postEvent(event) {
  try {
    await bridgeFetch("/events", { method: "POST", body: JSON.stringify(event) });
  } catch (error) {
    console.debug("Local bridge unavailable while posting event", error.message);
  }
}

async function attachTab(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach(debuggerTarget(tabId), "1.3");
    attachedTabs.add(tabId);
    await Promise.all([
      chrome.debugger.sendCommand(debuggerTarget(tabId), "Runtime.enable"),
      chrome.debugger.sendCommand(debuggerTarget(tabId), "Page.enable"),
      chrome.debugger.sendCommand(debuggerTarget(tabId), "Network.enable"),
    ]);
    await chrome.storage.session.set({ attachedTabIds: [...attachedTabs] });
    await postEvent({ type: "debugger-attached", tabId, at: new Date().toISOString() });
  } catch (error) {
    attachedTabs.delete(tabId);
    console.warn(`Could not attach debugger to tab ${tabId}:`, error.message);
  }
}

async function detachTab(tabId, reason) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach(debuggerTarget(tabId));
  } catch {
    // The browser may have already detached when the tab navigated or closed.
  }
  await chrome.storage.session.set({ attachedTabIds: [...attachedTabs] });
  await postEvent({ type: "debugger-detached", tabId, reason, at: new Date().toISOString() });
}

async function ensureTargetTabs() {
  const tabs = await chrome.tabs.query({});
  const currentTargetIds = new Set(tabs.filter((tab) => isTargetUrl(tab.url)).map((tab) => tab.id));
  await Promise.all([...attachedTabs].filter((id) => !currentTargetIds.has(id)).map((id) => detachTab(id, "url-no-longer-matches")));
  await Promise.all([...currentTargetIds].map((id) => attachTab(id)));
}

function blockedExpression(expression) {
  return /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|submit|requestSubmit|click|dispatchEvent|location\s*=|history\.(pushState|replaceState)|localStorage|sessionStorage|indexedDB|document\.cookie)\b/i.test(expression);
}

function validateCommand(command) {
  if (!command || typeof command !== "object" || typeof command.id !== "string") {
    throw new Error("Invalid command envelope");
  }
  if (!attachedTabs.has(command.tabId)) throw new Error("Target tab is not attached");

  if (command.kind === "eval") {
    if (typeof command.expression !== "string" || !command.expression.trim()) throw new Error("expression is required");
    if (!command.allowSideEffects && blockedExpression(command.expression)) {
      throw new Error("Expression contains a blocked side-effect API");
    }
    return {
      method: "Runtime.evaluate",
      params: {
        expression: command.expression,
        awaitPromise: Boolean(command.awaitPromise),
        returnByValue: command.returnByValue !== false,
        throwOnSideEffect: !command.allowSideEffects,
        userGesture: Boolean(command.allowSideEffects),
        allowUnsafeEvalBlockedByCSP: false,
      },
    };
  }

  const allowed = new Set([
    "Runtime.evaluate",
    "Runtime.getProperties",
    "Network.getResponseBody",
    "Page.captureScreenshot",
    "Page.getNavigationHistory",
    "Page.getResourceTree",
    "Page.navigate",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
  ]);
  if (command.kind !== "cdp" || !allowed.has(command.method)) throw new Error("CDP method is not read-only allowlisted");
  const params = command.params && typeof command.params === "object" ? { ...command.params } : {};
  if (command.method === "Runtime.evaluate") {
    if (typeof params.expression !== "string" || blockedExpression(params.expression)) throw new Error("Unsafe Runtime.evaluate expression");
    Object.assign(params, { throwOnSideEffect: true, userGesture: false, allowUnsafeEvalBlockedByCSP: false });
  }
  if (command.method === "Runtime.getProperties") {
    Object.assign(params, { ownProperties: true, accessorPropertiesOnly: true });
  }
  return { method: command.method, params };
}

async function executeCommand(command) {
  if (inFlightCommandIds.has(command.id)) return;
  inFlightCommandIds.add(command.id);
  try {
    const { method, params } = validateCommand(command);
    const result = await chrome.debugger.sendCommand(debuggerTarget(command.tabId), method, params);
    await postEvent({ type: "command-result", commandId: command.id, ok: true, result });
  } catch (error) {
    await postEvent({ type: "command-result", commandId: command.id, ok: false, error: error.message });
  } finally {
    inFlightCommandIds.delete(command.id);
  }
}

async function pollCommands() {
  if (polling || attachedTabs.size === 0) return;
  polling = true;
  try {
    const commands = await bridgeFetch(`/commands?tabIds=${[...attachedTabs].join(",")}`);
    await Promise.all((commands.items || []).map(executeCommand));
  } catch (error) {
    console.debug("Local bridge command poll failed", error.message);
  } finally {
    polling = false;
    schedulePoll();
  }
}

function schedulePoll(delayMs = 1_000) {
  if (pollScheduled) return;
  pollScheduled = true;
  setTimeout(() => {
    pollScheduled = false;
    pollCommands();
  }, delayMs);
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (!attachedTabs.has(tabId)) return;
  const requestId = params.requestId || "";
  const timestamp = params.timestamp || Date.now();
  const eventKey = `${tabId}:${method}:${requestId}:${timestamp}`;
  if (!rememberNetworkEvent(eventKey)) return;

  if (method === "Network.requestWillBeSent") {
    requestUrls.set(requestId, params.request?.url || "");
    if (shouldIgnoreUrl(params.request?.url)) return;
    await postEvent({
      type: "network-request",
      tabId,
      requestId,
      at: new Date().toISOString(),
      request: {
        url: params.request?.url,
        method: params.request?.method,
        headers: redactHeaders(params.request?.headers),
        hasPostData: Boolean(params.request?.hasPostData),
        postData: capText(params.request?.postData),
      },
    });
  } else if (method === "Network.responseReceived") {
    responseMimeTypes.set(requestId, params.response?.mimeType || "");
    if (shouldIgnoreUrl(params.response?.url)) return;
    await postEvent({
      type: "network-response",
      tabId,
      requestId,
      at: new Date().toISOString(),
      response: {
        url: params.response?.url,
        status: params.response?.status,
        mimeType: params.response?.mimeType,
        headers: redactHeaders(params.response?.headers),
      },
    });
  } else if (method === "Network.loadingFinished") {
    const requestUrl = requestUrls.get(requestId) || "";
    const responseMimeType = responseMimeTypes.get(requestId) || "";
    requestUrls.delete(requestId);
    responseMimeTypes.delete(requestId);
    if (!shouldCaptureBody(requestUrl, responseMimeType)) return;
    try {
      const body = await chrome.debugger.sendCommand(debuggerTarget(tabId), "Network.getResponseBody", { requestId });
      await postEvent({ type: "network-body", tabId, requestId, at: new Date().toISOString(), body: { ...body, body: capText(body.body) } });
    } catch (error) {
      await postEvent({ type: "network-body-unavailable", tabId, requestId, at: new Date().toISOString(), error: error.message });
    }
  }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (attachedTabs.delete(source.tabId)) {
    await chrome.storage.session.set({ attachedTabIds: [...attachedTabs] });
    await postEvent({ type: "debugger-detached", tabId: source.tabId, reason, at: new Date().toISOString() });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    if (isTargetUrl(tab.url)) await attachTab(tabId);
    else await detachTab(tabId, "tab-updated-to-non-target");
    await pollCommands();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => detachTab(tabId, "tab-closed"));
chrome.tabs.onActivated.addListener(async () => { await ensureTargetTabs(); await pollCommands(); });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === POLL_ALARM) {
    await ensureTargetTabs();
    await pollCommands();
  }
});
chrome.runtime.onStartup.addListener(() => ensureTargetTabs());
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  await postEvent({ type: "extension-installed", at: new Date().toISOString() });
  await ensureTargetTabs();
  await pollCommands();
});

chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
postEvent({ type: "extension-started", at: new Date().toISOString() });
ensureTargetTabs().then(pollCommands);
