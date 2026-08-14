import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLoggedInUrl } from "../worker/browser-url.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 19980 + Math.floor(Math.random() * 100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmall-worker-test-"));
let child;

async function waitForWorker() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("worker did not start");
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(root, "worker", "server.mjs")], {
    cwd: root,
    env: { ...process.env, TMALL_WORKER_PORT: String(port), TMALL_DATA_DIR: dataDir, TMALL_LIVE_ENABLED: "false" },
    stdio: "ignore",
  });
  await waitForWorker();
});

test.after(() => child?.kill());

test("health starts in safe demo mode", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const health = await response.json();
  assert.equal(health.ready, true);
  assert.equal(health.mode, "demo");
  assert.equal(health.contract, "demo");
  assert.equal(path.basename(health.profile), "edge-profile-v2");
  assert.equal(health.riskRequired, false);
  assert.equal(health.webdriver, null);
});

test("seller workbench and publish pages are recognized as logged in", () => {
  assert.equal(isLoggedInUrl("https://sell.publish.tmall.com/tmall/publish.htm?id=1"), true);
  assert.equal(isLoggedInUrl("https://myseller.taobao.com/home.htm/SellManage/all?current=1"), true);
  assert.equal(isLoggedInUrl("https://myseller.taobao.com/login.htm"), false);
  assert.equal(isLoggedInUrl("https://login.taobao.com/member/login.jhtml"), false);
});

test("demo batch runs item tasks and creates synthetic readback IDs", async () => {
  const create = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "demo", items: [{ itemId: "10001", skuIds: ["20001", "20002"], expectedSkuCount: 2 }] }),
  });
  assert.equal(create.status, 201);
  const { batchId } = await create.json();
  await new Promise((resolve) => setTimeout(resolve, 1400));
  const tasksResponse = await fetch(`http://127.0.0.1:${port}/tasks`);
  const { tasks } = await tasksResponse.json();
  const task = tasks.find((entry) => entry.batchId === batchId);
  assert.equal(task.status, "succeeded");
  assert.equal(task.newSkuIds.length, 2);
  assert.equal(task.progress, 100);
});

test("live mode requires the explicit confirmation phrase", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "live", confirmation: "", items: [{ itemId: "10002", skuIds: ["20003"] }] }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, "validation_error");
});

test("invalid item IDs are rejected before queueing", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "demo", items: [{ itemId: "bad", skuIds: [] }] }),
  });
  assert.equal(response.status, 400);
});

test("disallowed browser origins cannot call the local worker", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
    headers: { origin: "https://example.com" },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "origin_not_allowed");
});

test("expected SKU count must match the supplied SKU IDs", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "demo", items: [{ itemId: "10003", skuIds: ["20004"], expectedSkuCount: 2 }] }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.ok(payload.errors.some((message) => message.includes("数量不一致")));
});

test("item-only batches are accepted without pretending SKU readback succeeded", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "demo", items: [{ itemId: "828872681901", skuIds: [] }] }),
  });
  assert.equal(response.status, 201);
  const { batchId, tasks: createdTasks } = await response.json();
  assert.deepEqual(createdTasks[0].skuIds, []);

  await new Promise((resolve) => setTimeout(resolve, 1400));
  const { tasks } = await (await fetch(`http://127.0.0.1:${port}/tasks`)).json();
  const task = tasks.find((entry) => entry.batchId === batchId);
  assert.equal(task.status, "succeeded");
  assert.deepEqual(task.newSkuIds, []);
  const messages = task.timeline.map((entry) => entry.message).join("\n");
  assert.match(messages, /SKU 数量将在真实快照读取后校验/);
  assert.doesNotMatch(messages, /临时 SKU 回读成功|字段差异为 0/);
});

test("concurrent demo batches are queued and both finish", async () => {
  const create = (itemId, skuId) => fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "demo", items: [{ itemId, skuIds: [skuId], expectedSkuCount: 1 }] }),
  });
  const [first, second] = await Promise.all([create("10004", "20005"), create("10005", "20006")]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const [{ batchId: firstId }, { batchId: secondId }] = await Promise.all([first.json(), second.json()]);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const { tasks } = await (await fetch(`http://127.0.0.1:${port}/tasks`)).json();
  assert.equal(tasks.find((entry) => entry.batchId === firstId)?.status, "succeeded");
  assert.equal(tasks.find((entry) => entry.batchId === secondId)?.status, "succeeded");
});
