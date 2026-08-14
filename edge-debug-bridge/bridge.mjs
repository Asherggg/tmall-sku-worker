import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const HOST = "127.0.0.1";
const PORT = 19827;
const MAX_BODY_BYTES = 2_000_000;
const MAX_NETWORK_EVENTS = 2_000;
const COMMAND_TIMEOUT_MS = 70_000;

const network = [];
const pending = new Map();

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "http://127.0.0.1",
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds limit"));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Malformed JSON")); }
    });
    request.on("error", reject);
  });
}

function queuedCommand(kind, body) {
  const command = {
    id: randomUUID(),
    kind,
    tabId: Number(body.tabId),
    ...(kind === "eval"
      ? { expression: body.expression, awaitPromise: body.awaitPromise, returnByValue: body.returnByValue }
      : { method: body.method, params: body.params }),
  };
  if (!Number.isInteger(command.tabId)) throw new Error("tabId must be an integer attached target tab id");
  return command;
}

function waitForCommand(command) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(command.id);
      resolve({ ok: false, error: "Timed out waiting for extension poll" });
    }, COMMAND_TIMEOUT_MS);
    pending.set(command.id, { command, resolve, timeout });
  });
}

function eventMatchesFilter(event, url) {
  const type = url.searchParams.get("type");
  const requestId = url.searchParams.get("requestId");
  return (!type || event.type === type) && (!requestId || event.requestId === requestId);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { ok: true, host: HOST, port: PORT, pending: pending.size, networkEvents: network.length });
    }
    if (request.method === "GET" && url.pathname === "/commands") {
      const allowedTabs = new Set((url.searchParams.get("tabIds") || "").split(",").map(Number).filter(Number.isInteger));
      const items = [...pending.values()].map((entry) => entry.command).filter((command) => allowedTabs.has(command.tabId));
      return sendJson(response, 200, { items });
    }
    if (request.method === "POST" && url.pathname === "/events") {
      const event = await readJson(request);
      if (event.type === "command-result" && typeof event.commandId === "string") {
        const entry = pending.get(event.commandId);
        if (entry) {
          clearTimeout(entry.timeout);
          pending.delete(event.commandId);
          entry.resolve(event.ok ? { ok: true, result: event.result } : { ok: false, error: event.error || "Debugger command failed" });
        }
      } else {
        network.push(event);
        if (network.length > MAX_NETWORK_EVENTS) network.splice(0, network.length - MAX_NETWORK_EVENTS);
      }
      return sendJson(response, 202, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/network") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), MAX_NETWORK_EVENTS);
      const items = network.filter((event) => eventMatchesFilter(event, url)).slice(-limit);
      return sendJson(response, 200, { items, total: network.length });
    }
    if (request.method === "POST" && url.pathname === "/network/clear") {
      network.length = 0;
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && (url.pathname === "/eval" || url.pathname === "/eval-write" || url.pathname === "/cdp")) {
      const body = await readJson(request);
      const kind = url.pathname === "/eval-write" ? "eval" : url.pathname.slice(1);
      const command = queuedCommand(kind, body);
      if (url.pathname === "/eval-write") command.allowSideEffects = true;
      const resultPromise = waitForCommand(command);
      const result = await resultPromise;
      return sendJson(response, result.ok ? 200 : 409, { commandId: command.id, ...result });
    }
    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(response, 400, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tmall local debugger bridge listening at http://${HOST}:${PORT}`);
});
