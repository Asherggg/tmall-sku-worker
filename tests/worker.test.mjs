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

async function waitForWorkerAt(workerPort) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${workerPort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`worker on ${workerPort} did not start`);
}

function spawnWorker(workerPort, workerDataDir, extraEnv = {}) {
  return spawn(process.execPath, [path.join(root, "worker", "server.mjs")], {
    cwd: root,
    env: { ...process.env, TMALL_WORKER_PORT: String(workerPort), TMALL_DATA_DIR: workerDataDir, ...extraEnv },
    stdio: "ignore",
  });
}

async function stopWorker(processHandle) {
  if (!processHandle || processHandle.exitCode != null) return;
  await new Promise((resolve) => {
    processHandle.once("exit", resolve);
    processHandle.kill();
    setTimeout(resolve, 1500).unref();
  });
}

async function waitForTask(taskId, predicate, workerPort = port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${workerPort}/tasks/${taskId}`);
    const task = await response.json();
    if (response.ok && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`task ${taskId} did not reach expected state`);
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

test("live tasks cannot be paused after creation", async () => {
  const create = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "live", confirmation: "确认线上重建", items: [{ itemId: "10009", skuIds: ["20010"] }] }),
  });
  assert.equal(create.status, 201);
  const { tasks } = await create.json();
  const pause = await fetch(`http://127.0.0.1:${port}/tasks/${tasks[0].id}/pause`, { method: "POST" });
  assert.equal(pause.status, 409);
  assert.equal((await pause.json()).error, "live_task_not_pausable");
});

test("tasks can be manually deleted before live writing starts", async () => {
  const create = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "live", confirmation: "确认线上重建", items: [{ itemId: "10010", skuIds: [] }] }),
  });
  assert.equal(create.status, 201);
  const { batchId, tasks: createdTasks } = await create.json();
  const taskId = createdTasks[0].id;

  const deletion = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}`, { method: "DELETE" });
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { deleted: true, taskId, batchId, removedBatch: true, manuallyResolved: false });
  assert.equal((await fetch(`http://127.0.0.1:${port}/tasks/${taskId}`)).status, 404);
  const batches = await (await fetch(`http://127.0.0.1:${port}/batches`)).json();
  assert.equal(batches.batches.some((batch) => batch.id === batchId), false);
  const audit = await (await fetch(`http://127.0.0.1:${port}/audit/export`)).json();
  assert.equal(audit.records.find((entry) => entry.taskId === taskId)?.businessCode, "TASK_DELETED");
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

test("Tauri production and dev origins can call the worker", async () => {
  for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:1420", "http://localhost:1420"]) {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin } });
    assert.equal(response.status, 200, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
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
  const deadline = Date.now() + 8000;
  let tasks = [];
  while (Date.now() < deadline) {
    ({ tasks } = await (await fetch(`http://127.0.0.1:${port}/tasks`)).json());
    if ([firstId, secondId].every((batchId) => tasks.find((entry) => entry.batchId === batchId)?.status === "succeeded")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(tasks.find((entry) => entry.batchId === firstId)?.status, "succeeded");
  assert.equal(tasks.find((entry) => entry.batchId === secondId)?.status, "succeeded");
});

test("a live batch accepts only one concurrent start", async () => {
  const create = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "live", confirmation: "确认线上重建", items: [{ itemId: "10006", skuIds: ["20007"] }] }),
  });
  const { batchId } = await create.json();
  const start = () => fetch(`http://127.0.0.1:${port}/batches/${batchId}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "确认线上重建" }),
  });
  const responses = await Promise.all([start(), start()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  const batches = await (await fetch(`http://127.0.0.1:${port}/batches`)).json();
  assert.notEqual(batches.batches.find((batch) => batch.id === batchId)?.status, "starting");
});

test("retry runs only the queued task and does not replay sibling manual-review tasks", async () => {
  const create = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "live",
      confirmation: "确认线上重建",
      items: [
        { itemId: "10007", skuIds: ["20008"] },
        { itemId: "10008", skuIds: ["20009"] },
      ],
    }),
  });
  const created = await create.json();
  const [target, sibling] = created.tasks;
  await fetch(`http://127.0.0.1:${port}/batches/${created.batchId}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "确认线上重建" }),
  });
  await waitForTask(target.id, (task) => task.status === "needs_manual_review");
  await waitForTask(sibling.id, (task) => task.status === "needs_manual_review");

  const retry = await fetch(`http://127.0.0.1:${port}/tasks/${target.id}/retry`, { method: "POST" });
  assert.equal(retry.status, 202);
  const retried = await waitForTask(target.id, (task) => task.attempts === 2 && task.status === "needs_manual_review");
  const untouched = await (await fetch(`http://127.0.0.1:${port}/tasks/${sibling.id}`)).json();
  assert.equal(retried.attempts, 2);
  assert.equal(untouched.attempts, 1);
});

test("an unresolved live write survives restart and locks the item", async () => {
  const isolatedPort = port + 200;
  const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmall-worker-lock-test-"));
  const createdAt = new Date().toISOString();
  fs.writeFileSync(path.join(isolatedDataDir, "state.json"), `${JSON.stringify({
    batches: [
      { id: "old_batch", mode: "live", status: "failed", taskIds: ["old_task"], createdAt },
      { id: "waiting_batch", mode: "live", status: "queued", taskIds: ["waiting_task"], createdAt },
    ],
    tasks: [{
      id: "old_task",
      batchId: "old_batch",
      itemId: "828872681901",
      skuIds: [],
      mode: "live",
      status: "needs_manual_review",
      liveWriteStarted: true,
      attempts: 1,
      progress: 50,
      createdAt,
      updatedAt: createdAt,
      timeline: [],
    }, {
      id: "waiting_task",
      batchId: "waiting_batch",
      itemId: "828872681901",
      skuIds: [],
      mode: "live",
      status: "planned",
      attempts: 0,
      progress: 0,
      createdAt,
      updatedAt: createdAt,
      timeline: [],
    }],
    audit: [],
    browser: {},
  }, null, 2)}\n`, "utf8");

  let isolatedChild = spawnWorker(isolatedPort, isolatedDataDir, { TMALL_LIVE_ENABLED: "true", TMALL_LIVE_CONTRACT: "tmall-publish-v2" });
  try {
    await waitForWorkerAt(isolatedPort);
    assert.equal((await (await fetch(`http://127.0.0.1:${isolatedPort}/health`)).json()).unresolvedLiveWrites, 1);
    await stopWorker(isolatedChild);
    isolatedChild = spawnWorker(isolatedPort, isolatedDataDir, { TMALL_LIVE_ENABLED: "true", TMALL_LIVE_CONTRACT: "tmall-publish-v2" });
    await waitForWorkerAt(isolatedPort);

    const blockedStart = await fetch(`http://127.0.0.1:${isolatedPort}/batches/waiting_batch/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "确认线上重建" }),
    });
    assert.equal(blockedStart.status, 409);
    assert.equal((await blockedStart.json()).error, "item_write_unresolved");

    const blocked = await fetch(`http://127.0.0.1:${isolatedPort}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "live", confirmation: "确认线上重建", items: [{ itemId: "828872681901", skuIds: [] }] }),
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, "item_write_unresolved");

    const unrelated = await fetch(`http://127.0.0.1:${isolatedPort}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "live", confirmation: "确认线上重建", items: [{ itemId: "828872681902", skuIds: [] }] }),
    });
    assert.equal(unrelated.status, 201);

    const unconfirmedDeletion = await fetch(`http://127.0.0.1:${isolatedPort}/tasks/old_task`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(unconfirmedDeletion.status, 409);
    assert.equal((await unconfirmedDeletion.json()).error, "manual_review_confirmation_required");

    const confirmedDeletion = await fetch(`http://127.0.0.1:${isolatedPort}/tasks/old_task`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "确认已人工核对" }),
    });
    assert.equal(confirmedDeletion.status, 200);
    assert.equal((await confirmedDeletion.json()).manuallyResolved, true);
    assert.equal((await (await fetch(`http://127.0.0.1:${isolatedPort}/health`)).json()).unresolvedLiveWrites, 0);
    const audit = await (await fetch(`http://127.0.0.1:${isolatedPort}/audit/export`)).json();
    assert.equal(audit.records.find((entry) => entry.taskId === "old_task")?.businessCode, "TASK_MANUALLY_RESOLVED_AND_DELETED");
  } finally {
    await stopWorker(isolatedChild);
  }
});
