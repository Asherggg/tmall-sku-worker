import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ITEM_URL = "https://sell.publish.tmall.com/tmall/publish.htm?id=828872681901";
const OUT_DIR = path.resolve(process.cwd(), ".runtime", "tmall-spec");
const PORT_FILE = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data", "DevToolsActivePort");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wsUrl() {
  const [port, browserPath] = fs.readFileSync(PORT_FILE, "utf8").trim().split(/\r?\n/);
  return `ws://127.0.0.1:${port}${browserPath}`;
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      } else {
        this.events.push(msg);
      }
    };
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, 20_000);
    });
  }

  close() { this.ws.close(); }
}

const evaluate = (cdp, sessionId, expression) => cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cdp = new Cdp(wsUrl());
  await cdp.open();
  let sessionId;
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page" && t.url === ITEM_URL);
    const page = pages.find((t) => t.pid === 58680) || pages[0];
    if (!page) throw new Error("target not found");
    sessionId = (await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
    await cdp.send("Runtime.enable", {}, sessionId);
    const expression = String.raw`(async () => {
      const resources = [...performance.getEntriesByType('resource')]
        .filter((entry) => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')
        .map((entry) => entry.name);
      const candidates = [...new Set(resources.filter((url) => /sell\.publish|h5api\.m\.tmall|taobao\.com\/api|mtop/i.test(url)))];
      const results = [];
      for (const url of candidates) {
        try {
          const response = await fetch(url, { credentials: 'include' });
          const text = await response.text();
          results.push({ url, status: response.status, contentType: response.headers.get('content-type'), length: text.length, text: text.slice(0, 50000) });
        } catch (error) {
          results.push({ url, error: String(error) });
        }
      }
      return { candidates, results };
    })()`;
    const result = await evaluate(cdp, sessionId, expression);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(OUT_DIR, `api-probe-${stamp}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), targetId: page.targetId, pagePid: page.pid, ...(result.result?.value || result) }, null, 2)}${os.EOL}`, "utf8");
    console.log(JSON.stringify({ outputPath, targetId: page.targetId, candidateCount: result.result?.value?.candidates?.length, resultCount: result.result?.value?.results?.length }, null, 2));
  } finally {
    try { if (sessionId) await cdp.send("Target.detachFromTarget", { sessionId }); } catch {}
    cdp.close();
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
