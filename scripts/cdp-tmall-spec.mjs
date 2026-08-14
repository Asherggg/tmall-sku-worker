import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ITEM_URL = "https://sell.publish.tmall.com/tmall/publish.htm?id=828872681901";
const command = process.argv[2] || "inspect";
const portFile = path.join(
  process.env.LOCALAPPDATA || "",
  "Microsoft",
  "Edge",
  "User Data",
  "DevToolsActivePort",
);

function devtoolsUrl() {
  const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
  return `ws://127.0.0.1:${port}${browserPath}`;
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
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
      }, 15_000);
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(client, sessionId, expression) {
  const response = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || "Runtime evaluation failed");
  }
  return response.result.value;
}

function pageSnapshotExpression() {
  return String.raw`(() => {
    const cache = window.GlobalStore?.engine?._engine?._core?._componentCache;
    if (!cache) throw new Error("GlobalStore component cache is unavailable");
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const sku = clone(cache.sku.getProps().value || []);
    const saleProps = clone(cache.saleProp.getProps().value || {});
    const drawer = document.querySelector(".sku-decouple-drawer-container");
    const drawerOpen = !!drawer && drawer.getBoundingClientRect().width > 0;
    return {
      itemUrl: location.href,
      title: document.title,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      drawerOpen,
      saleProps,
      sku,
      capturedAt: new Date().toISOString(),
    };
  })()`;
}

async function main() {
  const client = new CdpClient(devtoolsUrl());
  await client.open();
  try {
    const { targetInfos } = await client.send("Target.getTargets");
    const pages = targetInfos.filter((target) => target.type === "page" && target.url === ITEM_URL);
    if (!pages.length) throw new Error(`No matching Edge tab: ${ITEM_URL}`);

    const snapshots = [];
    for (const page of pages) {
      const { sessionId } = await client.send(
        "Target.attachToTarget",
        { targetId: page.targetId, flatten: true },
      );
      await client.send("Runtime.enable", {}, sessionId);
      snapshots.push({ targetId: page.targetId, ...(await evaluate(client, sessionId, pageSnapshotExpression())) });
    }

    if (command === "inspect") {
      console.log(JSON.stringify(snapshots, null, 2));
      return;
    }
    if (command !== "snapshot") throw new Error(`Unknown command: ${command}`);

    const active = snapshots.find((snapshot) => snapshot.focused) || snapshots.find((snapshot) => snapshot.visibility === "visible") || snapshots[0];
    const outputDir = path.join(process.cwd(), ".runtime", "tmall-spec");
    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = path.join(outputDir, `828872681901-${stamp}.json`);
    fs.writeFileSync(output, `${JSON.stringify(active, null, 2)}${os.EOL}`, "utf8");
    console.log(JSON.stringify({ output, targetId: active.targetId, skuCount: active.sku.length, saleProps: active.saleProps }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
