import fs from "node:fs";
import path from "node:path";

const ITEM_URL = "https://sell.publish.tmall.com/tmall/publish.htm?id=828872681901";
const portFile = path.join(
  process.env.LOCALAPPDATA || "",
  "Microsoft",
  "Edge",
  "User Data",
  "DevToolsActivePort",
);

function readDevtoolsUrl() {
  const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
  return `ws://127.0.0.1:${port}${browserPath}`;
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method) this.events.push(message);
    };
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20_000);
    });
  }

  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(client, sessionId, expression) {
  const result = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Runtime evaluation failed");
  }
  return result.result?.value;
}

function snapshotExpression() {
  return String.raw`(() => {
    const clone = (value) => {
      try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
    };
    const cache = window.GlobalStore?.engine?._engine?._core?._componentCache;
    const sku = cache?.sku ? clone(cache.sku.getProps().value || []) : null;
    const saleProps = cache?.saleProp ? clone(cache.saleProp.getProps().value || {}) : null;
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .map((el) => ({
        text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
        cls: String(el.className || '').slice(0, 200),
        disabled: !!el.disabled,
      }))
      .filter((x) => x.text);
    const inputs = [...document.querySelectorAll('input,textarea,select')]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName,
        type: el.type || null,
        name: el.name || null,
        value: el.value || '',
        placeholder: el.placeholder || null,
        cls: String(el.className || '').slice(0, 200),
      }));
    return {
      url: location.href,
      title: document.title,
      focused: document.hasFocus(),
      drawerOpen: !!document.querySelector('.sku-decouple-drawer-container') && visible(document.querySelector('.sku-decouple-drawer-container')),
      saleProps,
      sku,
      buttons,
      inputs,
      text: (document.body.innerText || '').slice(-12000),
      capturedAt: new Date().toISOString(),
    };
  })()`;
}

function redact(value) {
  if (value == null) return value;
  if (typeof value !== "string") return value;
  return value
    .replace(/((?:^|[?&])(?:_tb_token_|token|csrfToken|csrf_token|auth_token|access_token|sign|sid|session|cookie)=[^&\s]*)/gi, "$1".replace(/=[^&\s]*/, "=<redacted>"))
    .replace(/(Cookie|Authorization|X-CSRF-Token)\s*:\s*[^\r\n]*/gi, "$1: <redacted>");
}

function safeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = /cookie|authorization|token|secret|sign/i.test(key) ? "<redacted>" : String(value);
  }
  return out;
}

async function main() {
  const client = new CdpClient(readDevtoolsUrl());
  await client.open();
  const outputDir = path.join(process.cwd(), ".runtime", "tmall-spec");
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outputDir, `live-open-${stamp}.json`);
  try {
    const { targetInfos } = await client.send("Target.getTargets");
    const pages = targetInfos.filter((target) => target.type === "page" && target.url === ITEM_URL);
    if (!pages.length) throw new Error(`No matching Edge tab: ${ITEM_URL}`);
    const attached = [];
    for (const page of pages) {
      const { sessionId } = await client.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      await client.send("Runtime.enable", {}, sessionId);
      const focused = await evaluate(client, sessionId, "document.hasFocus()");
      attached.push({ ...page, sessionId, focused });
    }
    const active = attached.find((page) => page.focused) || attached[0];
    await client.send("Network.enable", { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 }, active.sessionId);
    await client.send("Page.enable", {}, active.sessionId);
    await client.send("Log.enable", {}, active.sessionId);
    const before = await evaluate(client, active.sessionId, snapshotExpression());
    await evaluate(client, active.sessionId, String.raw`(() => {
      const nodes = [...document.querySelectorAll('button,[role="button"]')];
      const node = nodes.find((el) => (el.innerText || el.textContent || '').trim() === '编辑规格');
      if (!node) throw new Error('编辑规格 button not found');
      node.click();
      return true;
    })()`);
    await sleep(2500);
    const after = await evaluate(client, active.sessionId, snapshotExpression());
    const events = client.events.filter((event) => !event.sessionId || event.sessionId === active.sessionId);
    const requests = events.filter((event) => event.method === "Network.requestWillBeSent").map((event) => ({
      requestId: event.params.requestId,
      type: event.params.type,
      method: event.params.request.method,
      url: redact(event.params.request.url),
      headers: safeHeaders(event.params.request.headers),
      postData: event.params.request.postData ? redact(event.params.request.postData) : null,
      initiator: event.params.initiator?.type || null,
      timestamp: event.params.timestamp,
    }));
    const responses = events.filter((event) => event.method === "Network.responseReceived").map((event) => ({
      requestId: event.params.requestId,
      status: event.params.response.status,
      mimeType: event.params.response.mimeType,
      url: redact(event.params.response.url),
      headers: safeHeaders(event.params.response.headers),
      fromDiskCache: !!event.params.response.fromDiskCache,
    }));
    const failures = events.filter((event) => event.method === "Network.loadingFailed").map((event) => ({ requestId: event.params.requestId, errorText: event.params.errorText, canceled: event.params.canceled }));
    const output = { targetId: active.targetId, before, after, requests, responses, failures, capturedAt: new Date().toISOString() };
    fs.writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ outFile, targetId: active.targetId, requestCount: requests.length, responseCount: responses.length, failures: failures.length, drawerOpen: after.drawerOpen }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
