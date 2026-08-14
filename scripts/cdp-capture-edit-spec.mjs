import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ITEM_URL = "https://sell.publish.tmall.com/tmall/publish.htm?id=828872681901";
const OUT_DIR = path.resolve(process.cwd(), ".runtime", "tmall-spec");
const PORT_FILE = path.join(
  process.env.LOCALAPPDATA || "",
  "Microsoft",
  "Edge",
  "User Data",
  "DevToolsActivePort",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function devtoolsUrl() {
  const [port, browserPath] = fs.readFileSync(PORT_FILE, "utf8").trim().split(/\r?\n/);
  return `ws://127.0.0.1:${port}${browserPath}`;
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
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

  close() {
    this.ws.close();
  }
}

function redactHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^(cookie|set-cookie|authorization|x-csrf-token|x-xsrf-token)$/i.test(key)) {
      output[key] = "<redacted>";
    } else {
      output[key] = value;
    }
  }
  return output;
}

function isBusinessRequest(url = "") {
  if (!url) return false;
  if (!/(tmall|taobao|alicdn|alibaba)/i.test(url)) return false;
  return !/(mmstat|log\.|analytics|arms\.|fourier|insights|font|\.css(?:\?|$)|\.js(?:\?|$)|\.png(?:\?|$)|\.jpg(?:\?|$)|\.gif(?:\?|$)|\.woff|\.ico(?:\?|$))/i.test(url);
}

function isPageApiRequest(url = "") {
  if (!url) return false;
  if (!/(sell\.publish|h5api\.m\.tmall|acs\.m\.taobao|taobao\.com\/api|tmall\.com\/api|alicdn\.com\/sell)/i.test(url)) return false;
  return !/(mmstat|log\.|analytics|arms\.|fourier|insights|font|\.css(?:\?|$)|\.js(?:\?|$)|\.png(?:\?|$)|\.jpg(?:\?|$)|\.gif(?:\?|$)|\.woff|\.ico(?:\?|$))/i.test(url);
}

function safeSnapshotExpression() {
  return String.raw`(() => {
    const clone = (value) => {
      try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
    };
    const cache = window.GlobalStore?.engine?._engine?._core?._componentCache;
    const sku = cache?.sku?.getProps ? clone(cache.sku.getProps().value || []) : null;
    const saleProps = cache?.saleProp?.getProps ? clone(cache.saleProp.getProps().value || {}) : null;
    const drawer = document.querySelector('.sku-decouple-drawer-container');
    const editButtons = [...document.querySelectorAll('button')]
      .filter((button) => (button.innerText || '').trim() === '编辑规格')
      .map((button) => ({ disabled: !!button.disabled, rect: button.getBoundingClientRect().toJSON() }));
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      drawerOpen: !!drawer && drawer.getBoundingClientRect().width > 0,
      drawerText: drawer ? (drawer.innerText || '').slice(0, 3000) : '',
      editButtons,
      sku,
      saleProps,
      csrfPresent: typeof window.csrfToken === 'string' && window.csrfToken.length > 0,
    };
  })()`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const client = new CdpClient(devtoolsUrl());
  await client.open();
  const events = [];
  const requests = new Map();
  const responses = new Map();
  let sessionId;
  try {
    const { targetInfos } = await client.send("Target.getTargets");
    const pages = targetInfos.filter((target) => target.type === "page" && target.url === ITEM_URL);
    if (!pages.length) throw new Error(`No matching page: ${ITEM_URL}`);
    const focused = pages.find((target) => target.attached === false) || pages[0];
    const attached = await client.send("Target.attachToTarget", { targetId: focused.targetId, flatten: true });
    sessionId = attached.sessionId;
    const onEvent = (message) => {
      if (message.sessionId !== sessionId) return;
      const { method, params = {} } = message;
      if (!/^Network\.|^Page\.|^Runtime\.|^Log\./.test(method)) return;
      const record = { at: new Date().toISOString(), method, params };
      if (method === "Network.requestWillBeSent") {
        const request = params.request || {};
        const safe = {
          requestId: params.requestId,
          loaderId: params.loaderId,
          type: params.type,
          documentURL: params.documentURL,
          url: request.url,
          method: request.method,
          headers: redactHeaders(request.headers),
          postData: request.postData || undefined,
          hasUserGesture: params.hasUserGesture,
        };
        requests.set(params.requestId, safe);
        if (isBusinessRequest(request.url) || isPageApiRequest(request.url)) events.push({ ...record, params: safe });
      } else if (method === "Network.responseReceived") {
        const response = params.response || {};
        const safe = {
          requestId: params.requestId,
          type: params.type,
          url: response.url,
          status: response.status,
          statusText: response.statusText,
          mimeType: response.mimeType,
          headers: redactHeaders(response.headers),
          fromDiskCache: response.fromDiskCache,
          fromServiceWorker: response.fromServiceWorker,
        };
        responses.set(params.requestId, safe);
        if (isBusinessRequest(response.url) || isPageApiRequest(response.url) || response.status >= 400) events.push({ ...record, params: safe });
      } else if (method === "Network.loadingFinished") {
        const req = requests.get(params.requestId);
        if (req && (isBusinessRequest(req.url) || isPageApiRequest(req.url))) events.push({ ...record, params: { requestId: params.requestId, encodedDataLength: params.encodedDataLength } });
      } else if (method === "Network.loadingFailed" || method === "Runtime.exceptionThrown" || method === "Log.entryAdded") {
        events.push(record);
      } else if (method === "Page.frameNavigated") {
        events.push({ ...record, params: { frame: { id: params.frame?.id, url: params.frame?.url, name: params.frame?.name } } });
      }
    };
    client.listeners.add(onEvent);
    await Promise.all([
      client.send("Runtime.enable", {}, sessionId),
      client.send("Network.enable", { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 5 * 1024 * 1024 }, sessionId),
      client.send("Page.enable", {}, sessionId),
      client.send("Log.enable", {}, sessionId),
    ]);
    const before = await client.send("Runtime.evaluate", { expression: safeSnapshotExpression(), returnByValue: true, awaitPromise: true }, sessionId);
    const click = await client.send("Runtime.evaluate", {
      expression: String.raw`(() => {
        const button = [...document.querySelectorAll('button')].find((node) => (node.innerText || '').trim() === '编辑规格');
        if (!button) return { clicked: false, reason: 'button-not-found' };
        if (button.disabled) return { clicked: false, reason: 'button-disabled' };
        button.click();
        return { clicked: true, text: (button.innerText || '').trim() };
      })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, sessionId);
    await sleep(3500);
    const after = await client.send("Runtime.evaluate", { expression: safeSnapshotExpression(), returnByValue: true, awaitPromise: true }, sessionId);
    // Bodies are requested only for small, non-credential business responses.
    const bodySamples = [];
    for (const [requestId, response] of responses) {
      if (!(isBusinessRequest(response.url) || isPageApiRequest(response.url)) || !/^application\/(json|javascript)|text\//i.test(response.mimeType || "")) continue;
      try {
        const body = await client.send("Network.getResponseBody", { requestId }, sessionId);
        const text = String(body.body || "");
        bodySamples.push({ requestId, url: response.url, base64Encoded: !!body.base64Encoded, length: text.length, sample: text.slice(0, 20_000) });
      } catch (error) {
        bodySamples.push({ requestId, url: response.url, bodyError: String(error.message || error) });
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = {
      capturedAt: new Date().toISOString(),
      itemUrl: ITEM_URL,
      targetId: focused.targetId,
      targetPid: focused.pid,
      targetTitle: focused.title,
      pagesFound: pages.map((page) => ({ targetId: page.targetId, url: page.url, title: page.title, pid: page.pid })),
      clickResult: click.result?.value ?? null,
      before: before.result?.value ?? null,
      after: after.result?.value ?? null,
      businessRequests: [...requests.values()].filter((request) => isBusinessRequest(request.url) || isPageApiRequest(request.url)),
      businessResponses: [...responses.values()].filter((response) => isBusinessRequest(response.url) || isPageApiRequest(response.url) || response.status >= 400),
      bodySamples,
      events,
    };
    const outputPath = path.join(OUT_DIR, `edit-spec-capture-${stamp}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}${os.EOL}`, "utf8");
    console.log(JSON.stringify({ outputPath, targetId: focused.targetId, clickResult: output.clickResult, drawerBefore: output.before?.drawerOpen, drawerAfter: output.after?.drawerOpen, requestCount: output.businessRequests.length, responseCount: output.businessResponses.length, bodySampleCount: bodySamples.length }, null, 2));
  } finally {
    try { if (sessionId) await client.send("Target.detachFromTarget", { sessionId }); } catch {}
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
