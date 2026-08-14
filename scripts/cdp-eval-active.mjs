import fs from "node:fs";
import path from "node:path";

const portFile = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data", "DevToolsActivePort");
const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    };
    this.ws.onclose = () => this.rejectPending(new Error("CDP socket closed"));
    this.ws.onerror = () => this.rejectPending(new Error("CDP socket error"));
  }
  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
  open(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
        reject(new Error("timeout opening CDP socket"));
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
        reject(new Error("failed opening CDP socket"));
      };
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    this.rejectPending(new Error("CDP client closed"));
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

let expression = process.argv[2] || "({url:location.href,title:document.title})";
if (expression === "--file") expression = fs.readFileSync(process.argv[3], "utf8");
const c = new Cdp(`ws://127.0.0.1:${port}${browserPath}`);
const attached = new Set();
try {
  await c.open();
  const { targetInfos } = await c.send("Target.getTargets");
  const pages = targetInfos.filter((x) => x.type === "page" && /sell\.publish\.tmall\.com\/tmall\/publish\.htm\?id=828872681901/.test(x.url));
  if (!pages.length) throw new Error("no item page");
  let active;
  for (const p of pages) {
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: p.targetId, flatten: true });
    attached.add(sessionId);
    const r = await c.send("Runtime.evaluate", { expression: "document.hasFocus()", returnByValue: true }, sessionId);
    if (r.result?.value) {
      active = { ...p, sessionId };
      break;
    }
    await c.send("Target.detachFromTarget", { sessionId });
    attached.delete(sessionId);
  }
  if (!active) {
    const fallback = pages[0];
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: fallback.targetId, flatten: true });
    attached.add(sessionId);
    active = { ...fallback, sessionId };
  }
  const result = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, active.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "eval failed");
  console.log(JSON.stringify({ targetId: active.targetId, matchingPageCount: pages.length, result: result.result?.value }, null, 2));
} finally {
  for (const sessionId of attached) {
    try {
      await c.send("Target.detachFromTarget", { sessionId });
    } catch {
      // The browser may already have detached the target during shutdown.
    }
  }
  c.close();
}
