import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ITEM_RE = /sell\.publish\.tmall\.com\/tmall\/publish\.htm\?id=828872681901/;
async function resolveBrowserWebSocketUrl() {
  if (process.env.CDP_BROWSER_WS) return process.env.CDP_BROWSER_WS;

  if (process.env.CDP_PORT) {
    const version = await fetch(`http://127.0.0.1:${process.env.CDP_PORT}/json/version`);
    if (!version.ok) throw new Error(`Unable to read CDP version endpoint: ${version.status}`);
    const payload = await version.json();
    if (!payload.webSocketDebuggerUrl) throw new Error("CDP version endpoint did not return a WebSocket URL");
    return payload.webSocketDebuggerUrl;
  }

  const portFile = process.env.CDP_PORT_FILE || path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "Edge",
    "User Data",
    "DevToolsActivePort",
  );
  const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
  return `ws://127.0.0.1:${port}${browserPath}`;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }

  bindSocket() {
    this.ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    };
  }

  open(timeoutMs = 120_000) {
    this.ws = new WebSocket(this.url);
    this.bindSocket();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
        reject(new Error("CDP socket authorization timed out"));
      }, timeoutMs);
      this.ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("CDP socket failed"));
      };
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

function sanitizeHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/cookie|authorization|token/i.test(key)) output[key] = "[redacted]";
    else output[key] = value;
  }
  return output;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function reply(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

const browserWebSocketUrl = await resolveBrowserWebSocketUrl();
const client = new CdpClient(browserWebSocketUrl);
let pages;
let active;
try {
  console.log(JSON.stringify({ phase: "waiting-for-cdp", browserWebSocketUrl }));
  await client.open(600_000);
  console.log(JSON.stringify({ phase: "cdp-connected" }));

  const { targetInfos } = await client.send("Target.getTargets");
  pages = targetInfos.filter((target) => target.type === "page" && ITEM_RE.test(target.url));
  if (!pages.length) throw new Error("No matching Tmall item tab");

  active = null;
  for (const page of pages) {
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const focus = await client.send(
      "Runtime.evaluate",
      { expression: "document.hasFocus()", returnByValue: true },
      sessionId,
    );
    if (focus.result?.value) {
      active = { ...page, sessionId };
      break;
    }
    await client.send("Target.detachFromTarget", { sessionId });
  }
  if (!active) {
    const page = pages[0];
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    active = { ...page, sessionId };
  }

  await client.send("Runtime.enable", {}, active.sessionId);
  await client.send("Page.enable", {}, active.sessionId);
  await client.send("Network.enable", { maxPostDataSize: 10_000_000 }, active.sessionId);
} catch (error) {
  if (client.ws.readyState === WebSocket.OPEN || client.ws.readyState === WebSocket.CONNECTING) {
    client.ws.close();
  }
  throw error;
}

const traffic = new Map();
const bodyTasks = new Set();
client.listeners.add((message) => {
  if (message.sessionId !== active.sessionId) return;
  const { method, params = {} } = message;
  if (method === "Network.requestWillBeSent") {
    const { requestId, request, type, timestamp } = params;
    traffic.set(requestId, {
      requestId,
      type,
      timestamp,
      request: {
        method: request.method,
        url: request.url,
        headers: sanitizeHeaders(request.headers),
        postData: request.postData,
        hasPostData: request.hasPostData,
      },
    });
  } else if (method === "Network.responseReceived") {
    const entry = traffic.get(params.requestId);
    if (entry) {
      entry.response = {
        status: params.response.status,
        statusText: params.response.statusText,
        mimeType: params.response.mimeType,
        url: params.response.url,
        headers: sanitizeHeaders(params.response.headers),
      };
    }
  } else if (method === "Network.loadingFailed") {
    const entry = traffic.get(params.requestId);
    if (entry) entry.failure = { errorText: params.errorText, canceled: params.canceled };
  } else if (method === "Network.loadingFinished") {
    const entry = traffic.get(params.requestId);
    if (!entry || !["XHR", "Fetch", "Document"].includes(entry.type)) return;
    const task = client
      .send("Network.getResponseBody", { requestId: params.requestId }, active.sessionId, 10_000)
      .then(({ body, base64Encoded }) => {
        entry.responseBody = base64Encoded ? "[base64 omitted]" : body.slice(0, 2_000_000);
      })
      .catch((error) => {
        entry.responseBodyError = error.message;
      })
      .finally(() => bodyTasks.delete(task));
    bodyTasks.add(task);
  }
});

async function evaluate(expression) {
  const result = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    active.sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Runtime evaluation failed");
  }
  return result.result?.value;
}

function classifyTraffic(entries) {
  return entries.filter((entry) => {
    if (!["XHR", "Fetch", "Document"].includes(entry.type)) return false;
    try {
      const url = new URL(entry.request.url);
      return url.hostname === "sell.publish.tmall.com";
    } catch {
      return false;
    }
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      reply(response, 200, {
        ready: true,
        targetId: active.targetId,
        matchingPageCount: pages.length,
        url: active.url,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/network") {
      await Promise.allSettled([...bodyTasks]);
      const entries = [...traffic.values()];
      reply(response, 200, { businessTraffic: classifyTraffic(entries), traffic: entries });
      return;
    }
    if (request.method === "POST" && request.url === "/network/clear") {
      traffic.clear();
      reply(response, 200, { cleared: true });
      return;
    }
    if (request.method === "POST" && request.url === "/eval") {
      const expression = await readBody(request);
      reply(response, 200, { result: await evaluate(expression) });
      return;
    }
    if (request.method === "POST" && request.url === "/cdp") {
      const { method, params } = JSON.parse(await readBody(request));
      reply(response, 200, { result: await client.send(method, params || {}, active.sessionId) });
      return;
    }
    reply(response, 404, { error: "not_found" });
  } catch (error) {
    reply(response, 500, { error: error.stack || error.message });
  }
});

const bridgePort = Number(process.env.BRIDGE_PORT || 19_826);
server.listen(bridgePort, "127.0.0.1", () => {
  console.log(JSON.stringify({
    phase: "bridge-ready",
    bridge: `http://127.0.0.1:${bridgePort}`,
    targetId: active.targetId,
    matchingPageCount: pages.length,
  }));
});

process.on("SIGINT", () => {
  server.close();
  client.ws.close();
  process.exit(0);
});
