import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLoggedInUrl, isRiskPage } from "../worker/browser-url.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

const port = await availablePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmall-worker-test-"));
let child;

async function waitForWorker() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`worker on ${port} did not start (exit=${child?.exitCode}, stderr=${child?.__stderr || "none"})`);
}

async function waitForWorkerAt(workerPort) {
  const deadline = Date.now() + 15000;
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
  const processHandle = spawn(process.execPath, [path.join(root, "worker", "server.mjs")], {
    cwd: root,
    env: { ...process.env, TMALL_WORKER_PORT: String(workerPort), TMALL_DATA_DIR: workerDataDir, ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  processHandle.__stderr = "";
  processHandle.stderr.on("data", (chunk) => { processHandle.__stderr += chunk.toString(); });
  return processHandle;
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode != null) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      processHandle.off("exit", onExit);
      resolve(processHandle.exitCode != null);
    }, timeoutMs);
    processHandle.once("exit", onExit);
  });
}

async function stopWorker(processHandle) {
  if (!processHandle || processHandle.exitCode != null) return;
  const gracefulExit = waitForExit(processHandle, 5000);
  processHandle.kill();
  if (await gracefulExit || processHandle.exitCode != null) return;
  const forcedExit = waitForExit(processHandle, 5000);
  processHandle.kill("SIGKILL");
  await forcedExit;
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
  child = spawnWorker(port, dataDir, { TMALL_LIVE_ENABLED: "false" });
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
  assert.equal(health.liveBatchConcurrency, 2);
});

test("live health requires only the SKU rebuild contract", async () => {
  const isolatedPort = await availablePort();
  const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmall-worker-config-test-"));
  let isolatedChild = spawnWorker(isolatedPort, isolatedDataDir, {
    TMALL_LIVE_ENABLED: "true",
    TMALL_LIVE_CONTRACT: "",
  });
  try {
    await waitForWorkerAt(isolatedPort);
    const missing = await (await fetch(`http://127.0.0.1:${isolatedPort}/health`)).json();
    assert.equal(missing.workerVersion, "0.1.31");
    assert.equal(missing.contract, "missing");
    assert.deepEqual(missing.workflow.missing, ["sku_rebuild", "add_pattern"]);
    assert.match(missing.message, /天猫商品写入契约未配置/);
    assert.equal(Object.hasOwn(missing, "inventory"), false);
    assert.equal(Object.hasOwn(missing, "subsidy"), false);
    assert.equal(Object.hasOwn(missing, "omsLoggedIn"), false);

    await stopWorker(isolatedChild);
    isolatedChild = spawnWorker(isolatedPort, isolatedDataDir, {
      TMALL_LIVE_ENABLED: "true",
      TMALL_LIVE_CONTRACT: "tmall-publish-v2",
    });
    await waitForWorkerAt(isolatedPort);
    const configured = await (await fetch(`http://127.0.0.1:${isolatedPort}/health`)).json();
    assert.equal(configured.contract, "configured");
    assert.deepEqual(configured.workflow.missing, []);
    assert.equal(configured.message, "SKU ID 重建与新增花型流程已配置");
  } finally {
    await stopWorker(isolatedChild);
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  }
});

test("clean worker does not expose removed workflow endpoints", async () => {
  for (const endpoint of ["/inventory/health", "/inventory/lookup", "/browser/oms", "/browser/subsidy"]) {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: endpoint === "/inventory/health" ? "GET" : "POST" });
    assert.equal(response.status, 404, endpoint);
  }
});

test("seller login and risk signals are classified", () => {
  assert.equal(isLoggedInUrl("https://sell.publish.tmall.com/tmall/publish.htm?id=1"), true);
  assert.equal(isLoggedInUrl("https://myseller.taobao.com/home.htm/SellManage/all?current=1"), true);
  assert.equal(isLoggedInUrl("https://myseller.taobao.com/login.htm"), false);
  assert.equal(isLoggedInUrl("https://login.taobao.com/member/login.jhtml"), false);
  assert.equal(isRiskPage("https://myseller.taobao.com/home.htm/verify", "安全验证"), true);
  assert.equal(isRiskPage("https://myseller.taobao.com/home.htm/SellManage/all", "商品管理"), false);
});

test("demo batch runs item tasks and creates synthetic readback IDs", async () => {
  const create = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "demo", items: [{ itemId: "10001", skuIds: ["20001", "20002"], expectedSkuCount: 2 }] }),
  });
  assert.equal(create.status, 201);
  const { tasks: createdTasks } = await create.json();
  const task = await waitForTask(createdTasks[0].id, (entry) => entry.status === "succeeded");
  assert.equal(task.status, "succeeded");
  assert.equal(task.newSkuIds.length, 2);
  assert.equal(task.progress, 100);
});

test("add-pattern demo batches persist normalized Excel rows and can be filtered", async () => {
  const create = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "add_pattern",
      mode: "demo",
      items: [{
        itemId: "819488060800",
        rows: [{
          sourceRow: 2,
          specification: "150cm×210cm",
          color: "新花型",
          price: "899",
          quantity: 1,
          merchantCode: "NEW-523673",
          barcode: "6923283207999",
          remark: "新增",
        }],
      }],
    }),
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.tasks[0].operation, "add_pattern");
  assert.equal(created.tasks[0].patternRows[0].price, "899.00");
  const task = await waitForTask(created.tasks[0].id, (entry) => entry.status === "succeeded");
  assert.equal(task.addedSkuIds.length, 1);
  assert.match(task.timeline.at(-1).message, /1 条 Excel 组合/);

  const patternTasks = await (await fetch(`http://127.0.0.1:${port}/tasks?operation=add_pattern`)).json();
  assert.equal(patternTasks.tasks.some((entry) => entry.id === task.id), true);
  assert.equal(patternTasks.tasks.every((entry) => entry.operation === "add_pattern"), true);
  const rebuildTasks = await (await fetch(`http://127.0.0.1:${port}/tasks?operation=sku_rebuild`)).json();
  assert.equal(rebuildTasks.tasks.some((entry) => entry.id === task.id), false);
});

test("add-pattern live mode requires its own explicit confirmation phrase", async () => {
  const item = {
    itemId: "819488060801",
    rows: [{ sourceRow: 2, specification: "150cm", color: "新花型", price: "99.00", quantity: 0, merchantCode: "NEW-1", barcode: "", remark: "" }],
  };
  const wrong = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "add_pattern", mode: "live", confirmation: "确认线上重建", items: [item] }),
  });
  assert.equal(wrong.status, 400);
  const accepted = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "add_pattern", mode: "live", confirmation: "确认线上新增花型", items: [item] }),
  });
  assert.equal(accepted.status, 201);
});

test("add-pattern rows are rejected before queueing when fields or combinations are invalid", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "add_pattern",
      mode: "demo",
      items: [{
        itemId: "819488060802",
        rows: [
          { sourceRow: 2, specification: "150cm", color: "花型", price: "99", quantity: 1, merchantCode: "A", barcode: "", remark: "" },
          { sourceRow: 3, specification: "150cm", color: "花型", price: "99", quantity: 1, merchantCode: "A", barcode: "", remark: "" },
        ],
      }],
    }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, "validation_error");
  assert.ok(payload.errors.some((message) => message.includes("组合重复")));
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
  const { tasks: createdTasks } = await response.json();
  assert.deepEqual(createdTasks[0].skuIds, []);

  const task = await waitForTask(createdTasks[0].id, (entry) => entry.status === "succeeded");
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

test("legacy channel tasks require a per-task explicit selection and confirmation before retry", async () => {
  const isolatedPort = await availablePort();
  const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmall-worker-migration-test-"));
  const createdAt = new Date().toISOString();
  const makeTask = (id, errorCode, observed) => ({
    id, batchId: "migration_batch", operation: "add_pattern", itemId: id === "legacy_task" ? "10070" : "10071",
    skuIds: [], patternRows: [], mode: "live", status: "needs_manual_review", errorCode,
    ...(observed !== undefined ? { channelOptionObserved: observed } : {}),
    liveWriteStarted: false, attempts: 1, progress: 0, createdAt, updatedAt: createdAt, timeline: [],
  });
  fs.writeFileSync(path.join(isolatedDataDir, "state.json"), `${JSON.stringify({
    batches: [{ id: "migration_batch", mode: "live", operation: "add_pattern", status: "failed", taskIds: ["legacy_task", "typed_task"], createdAt }],
    tasks: [makeTask("legacy_task", "channel_option_invalid"), makeTask("typed_task", "channel_option_migration_required", "")],
    audit: [], browser: {},
  })}\n`, "utf8");
  const isolatedChild = spawnWorker(isolatedPort, isolatedDataDir, { TMALL_LIVE_ENABLED: "false" });
  const url = `http://127.0.0.1:${isolatedPort}`;
  const retry = (id, payload = {}) => fetch(`${url}/tasks/${id}/retry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  try {
    await waitForWorkerAt(isolatedPort);
    const initial = await (await fetch(`${url}/tasks/typed_task`)).json();
    assert.equal(initial.attempts, 1);
    const missing = await retry("typed_task");
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).error, "channel_migration_required");
    for (const channelOption of ["5", "", "3"]) {
      const rejected = await retry("typed_task", { channelOption, confirmChannelMigration: true });
      assert.equal(rejected.status, 409);
    }
    const unconfirmed = await retry("typed_task", { channelOption: "2" });
    assert.equal(unconfirmed.status, 409);
    assert.equal((await unconfirmed.json()).error, "channel_migration_confirmation_required");
    const typedBefore = await (await fetch(`${url}/tasks/typed_task`)).json();
    assert.equal(typedBefore.attempts, 1);
    assert.equal(typedBefore.channelOption, undefined);
    const accepted = await retry("typed_task", { channelOption: "2", confirmChannelMigration: true });
    assert.equal(accepted.status, 202);
    const typed = await waitForTask("typed_task", (entry) => entry.attempts === 2 && entry.status === "needs_manual_review", isolatedPort);
    assert.equal(typed.channelOption, "2");
    assert.equal(typed.channelOptionSource, "");
    assert.equal(typed.liveWriteStarted, false);
    assert.equal((await retry("typed_task", { channelOption: "1" })).status, 409);
    const legacy = await retry("legacy_task", { channelOption: "1", confirmChannelMigration: true });
    assert.equal(legacy.status, 202);
    const retried = await waitForTask("legacy_task", (entry) => entry.attempts === 2 && entry.status === "needs_manual_review", isolatedPort);
    assert.equal(retried.channelOption, "1");
    assert.equal(retried.channelOptionSource, undefined);
    const audit = await (await fetch(`${url}/audit/export`)).json();
    assert.equal(audit.records.filter((entry) => entry.method === "POST" && entry.path.includes("submit.htm")).length, 0);
  } finally {
    await stopWorker(isolatedChild);
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  }
});

test("new batch inputs cannot smuggle a channel selection", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "demo", operation: "add_pattern", items: [{
      itemId: "10072", channelOption: "1", rows: [{ sourceRow: 2, specification: "尺寸", color: "花型", price: "1.00", quantity: 1 }],
    }] }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).errors.join(" "), /销售渠道只能在任务读取旧值后人工选择/);
});
test("restart recovery converts orphaned queued and executing tasks without auto-resuming them", async () => {
  const isolatedPort = await availablePort();
  const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmall-worker-restart-recovery-test-"));
  const createdAt = new Date().toISOString();
  fs.writeFileSync(path.join(isolatedDataDir, "state.json"), `${JSON.stringify({
    batches: [{ id: "orphan_batch", mode: "live", status: "running", taskIds: ["interrupted_task", "queued_task"], createdAt }],
    tasks: [{
      id: "interrupted_task",
      batchId: "orphan_batch",
      itemId: "828872681910",
      skuIds: [],
      mode: "live",
      status: "pattern_verifying",
      liveWriteStarted: true,
      writePhase: "pattern",
      attempts: 1,
      progress: 75,
      createdAt,
      updatedAt: createdAt,
      timeline: [],
    }, {
      id: "queued_task",
      batchId: "orphan_batch",
      itemId: "828872681911",
      skuIds: [],
      mode: "live",
      status: "queued",
      attempts: 1,
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
    await new Promise((resolve) => setTimeout(resolve, 250));
    const interrupted = await (await fetch(`http://127.0.0.1:${isolatedPort}/tasks/interrupted_task`)).json();
    const queued = await (await fetch(`http://127.0.0.1:${isolatedPort}/tasks/queued_task`)).json();
    assert.equal(interrupted.status, "needs_manual_review");
    assert.equal(interrupted.errorCode, "manual_recovery_required");
    assert.equal(interrupted.liveWriteStarted, true);
    assert.equal(queued.status, "needs_manual_review");
    assert.equal(queued.errorCode, "worker_restart_recovery_required");
    assert.equal((await (await fetch(`http://127.0.0.1:${isolatedPort}/batches`)).json()).batches[0].status, "failed");
    assert.equal((await (await fetch(`http://127.0.0.1:${isolatedPort}/health`)).json()).unresolvedLiveWrites, 1);
    const audit = await (await fetch(`http://127.0.0.1:${isolatedPort}/audit/export`)).json();
    assert.equal(audit.records.filter((entry) => entry.phase === "restart_recovery").length, 2);

    const blockedDeletion = await fetch(`http://127.0.0.1:${isolatedPort}/tasks/interrupted_task`, { method: "DELETE" });
    assert.equal(blockedDeletion.status, 409);
    const confirmedDeletion = await fetch(`http://127.0.0.1:${isolatedPort}/tasks/interrupted_task`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "确认已人工核对" }),
    });
    assert.equal(confirmedDeletion.status, 200);
    assert.equal((await confirmedDeletion.json()).manuallyResolved, true);
    assert.equal((await (await fetch(`http://127.0.0.1:${isolatedPort}/health`)).json()).unresolvedLiveWrites, 0);
  } finally {
    await stopWorker(isolatedChild);
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  }
});

test("an unresolved live write survives restart and locks the item", async () => {
  const isolatedPort = await availablePort();
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
