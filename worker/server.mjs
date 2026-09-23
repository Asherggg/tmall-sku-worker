import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLoggedInUrl, isRiskPage } from "./browser-url.mjs";
import { executeTmallAddPattern, executeTmallRebuild } from "./tmall-live-adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TMALL_WORKER_PORT || 19828);
const HOST = process.env.TMALL_WORKER_HOST || "127.0.0.1";
const DATA_DIR = process.env.TMALL_DATA_DIR || path.join(__dirname, "..", ".runtime", "tmall-worker");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SKU_REBUILD_CONFIRMATION = "确认线上重建";
const ADD_PATTERN_CONFIRMATION = "确认线上新增花型";
const MANUAL_REVIEW_CONFIRMATION = "确认已人工核对";
const VALID_CHANNEL_OPTIONS = new Set(["1", "2"]);
const CHANNEL_OPTION_LABELS = Object.freeze({ "1": "纯电商", "2": "商场同款" });
const VERSION = "0.1.31";
const LIVE_BATCH_CONCURRENCY = Math.min(2, Math.max(1, Number.parseInt(process.env.TMALL_LIVE_CONCURRENCY || "2", 10) || 2));
const DEFAULT_LOGIN_URL = "https://myseller.taobao.com/home.htm/QnworkbenchHome/";
const BROWSER_CDP_PORT = Number(process.env.TMALL_BROWSER_CDP_PORT || PORT + 1);

fs.mkdirSync(DATA_DIR, { recursive: true });

const initialState = () => ({ batches: [], tasks: [], audit: [], browser: { visible: false, hidden: false, loggedIn: false, riskRequired: false, webdriver: null, profile: process.env.TMALL_BROWSER_PROFILE || path.join(DATA_DIR, "edge-profile-v2"), strategy: process.platform === "win32" ? "system-edge-cdp" : "playwright" } });

function readState() {
  try {
    return { ...initialState(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return initialState();
  }
}

let state = readState();
state.browser = { ...initialState().browser, ...state.browser, profile: initialState().browser.profile, visible: false, hidden: false, loggedIn: false };
let activeBatchId = null;
const pendingRuns = [];
const scheduledRuns = new Map();
const runningTaskIds = new Set();
let browserConnection = null;
let browserContext = null;
let browserPage = null;
let edgeProcess = null;
let liveWriteTail = Promise.resolve();

const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:1420",
  "http://localhost:1420",
  "tauri://localhost",
  "http://tauri.localhost",
]);

function originAllowed(origin) {
  return !origin || allowedOrigins.has(origin) || process.env.TMALL_ALLOW_ORIGIN === origin;
}

function saveState() {
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temp, STATE_FILE);
}

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`; }
function requestId() { return crypto.randomUUID(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function withLiveWriteLock(operation) {
  const previous = liveWriteTail;
  let release;
  liveWriteTail = new Promise((resolve) => { release = resolve; });
  return previous.then(async () => {
    try {
      return await operation();
    } finally {
      release();
    }
  });
}

function json(response, status, payload, rid) {
  const corsOrigin = response.__corsOrigin || "null";
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": corsOrigin,
    "vary": "Origin",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "x-request-id": rid || requestId(),
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("请求体不是有效 JSON"); }
}

function addAudit(task, phase, details = {}) {
  state.audit.unshift({
    id: id("audit"),
    taskId: task.id,
    itemId: task.itemId,
    phase,
    method: details.method || "LOCAL",
    path: details.path || "worker://local",
    status: details.status,
    ...(Number.isFinite(Number(details.durationMs)) ? { durationMs: Number(details.durationMs) } : {}),
    ...(Number.isFinite(Number(details.elapsedMs)) ? { elapsedMs: Number(details.elapsedMs) } : {}),
    ...(Number.isFinite(Number(details.attempts)) ? { attempts: Number(details.attempts) } : {}),
    ...(Number.isFinite(Number(details.deadlineMs)) ? { deadlineMs: Number(details.deadlineMs) } : {}),
    ...(typeof details.deadlineReadback === "boolean" ? { deadlineReadback: details.deadlineReadback } : {}),
    ...(Number.isFinite(Number(details.recordCount)) ? { recordCount: Number(details.recordCount) } : {}),
    ...(details.strategy ? { strategy: details.strategy } : {}),
    ...(details.transport ? { transport: details.transport } : {}),
    ...(details.fastReadbackError ? { fastReadbackError: details.fastReadbackError } : {}),
    businessCode: details.businessCode,
    requestId: details.requestId || requestId(),
    at: now(),
  });
  state.audit = state.audit.slice(0, 1000);
}

function addTimeline(task, phase, message, level = "info") {
  if (!Array.isArray(task.timeline)) task.timeline = [];
  task.timeline.push({ at: now(), phase, message, level });
  task.updatedAt = now();
  task.phaseLabel = message;
}

function taskOperation(task) {
  return task?.operation === "add_pattern" ? "add_pattern" : "sku_rebuild";
}

function confirmationFor(operation) {
  return operation === "add_pattern" ? ADD_PATTERN_CONFIRMATION : SKU_REBUILD_CONFIRMATION;
}

function normalizeChannelSelection(value) {
  const candidate = value && typeof value === "object" ? value.value : value;
  const normalized = String(candidate ?? "");
  return VALID_CHANNEL_OPTIONS.has(normalized) ? normalized : null;
}

function channelLabel(value) {
  return CHANNEL_OPTION_LABELS[String(value)] || String(value || "");
}

function normalizePatternPrice(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(text) || Number(text) <= 0) return null;
  const [integer, decimal = ""] = text.split(".");
  return `${integer}.${decimal.padEnd(2, "0")}`;
}

function validateItems(items, operation = "sku_rebuild") {
  const errors = [];
  if (!Array.isArray(items) || !items.length) errors.push("items 不能为空");
  if (operation !== "sku_rebuild" && operation !== "add_pattern") errors.push(`operation 无效: ${operation}`);
  const seen = new Set();
  let totalPatternRows = 0;
  for (const item of items || []) {
    const itemId = String(item?.itemId || "").trim();
    if (!/^\d+$/.test(itemId)) errors.push(`itemId 无效: ${itemId || "空"}`);
    if (seen.has(itemId)) errors.push(`itemId 重复: ${itemId}`);
    seen.add(itemId);
    if (operation === "add_pattern") {
      if (item?.channelOption !== undefined) errors.push(`销售渠道只能在任务读取旧值后人工选择: ${itemId}`);
      const rows = Array.isArray(item?.rows) ? item.rows : [];
      if (!rows.length || rows.length > 500) errors.push(`新增花型明细必须为 1 到 500 行: ${itemId}`);
      totalPatternRows += rows.length;
      const combinations = new Set();
      const merchantCodes = new Set();
      for (const [index, row] of rows.entries()) {
        const sourceRow = Number(row?.sourceRow ?? index + 2);
        const specification = String(row?.specification ?? "").trim();
        const color = String(row?.color ?? "").trim();
        const price = normalizePatternPrice(row?.price);
        const quantity = Number(row?.quantity);
        const merchantCode = String(row?.merchantCode ?? "").trim();
        const barcode = String(row?.barcode ?? "").trim();
        const remark = String(row?.remark ?? "").trim();
        if (!Number.isInteger(sourceRow) || sourceRow < 2 || !specification || !color || !price
          || !Number.isInteger(quantity) || quantity < 0 || quantity > 999_999_999
          || specification.length > 200 || color.length > 200 || merchantCode.length > 64
          || barcode.length > 64 || remark.length > 500) {
          errors.push(`新增花型第 ${sourceRow || index + 2} 行无效: ${itemId}`);
          continue;
        }
        const combination = `${specification}\u0000${color}`;
        if (combinations.has(combination)) errors.push(`新增花型组合重复: ${itemId} 第 ${sourceRow} 行`);
        combinations.add(combination);
        if (merchantCode) {
          if (merchantCodes.has(merchantCode)) errors.push(`新增花型商家编码重复: ${itemId} 第 ${sourceRow} 行`);
          merchantCodes.add(merchantCode);
        }
      }
      continue;
    }
    if (item?.channelOption !== undefined) errors.push(`销售渠道只能在任务读取旧值后人工选择: ${itemId}`);
    const skuIds = Array.isArray(item?.skuIds) ? item.skuIds.map(String).filter(Boolean) : [];
    if (skuIds.some((skuId) => !/^\d+$/.test(skuId))) errors.push(`skuId 无效: ${itemId}`);
    if (item?.expectedSkuCount != null && (!Number.isInteger(Number(item.expectedSkuCount)) || Number(item.expectedSkuCount) < 1)) errors.push(`expectedSkuCount 无效: ${itemId}`);
    if (skuIds.length && item?.expectedSkuCount != null && Number(item.expectedSkuCount) !== skuIds.length) errors.push(`expectedSkuCount 与 skuId 数量不一致: ${itemId}`);
  }
  if (operation === "add_pattern" && totalPatternRows > 500) errors.push(`新增花型批次共 ${totalPatternRows} 行，超过 500 行上限`);
  return errors;
}

function normalizedPatternRows(item) {
  return item.rows.map((row, index) => ({
    sourceRow: Number(row.sourceRow ?? index + 2),
    specification: String(row.specification).trim(),
    color: String(row.color).trim(),
    price: normalizePatternPrice(row.price),
    quantity: Number(row.quantity),
    merchantCode: String(row.merchantCode ?? "").trim(),
    barcode: String(row.barcode ?? "").trim(),
    remark: String(row.remark ?? "").trim(),
  }));
}

function phaseFor(status) {
  return {
    draft: "待校验", validated: "已校验", planned: "已计划", awaiting_confirmation: "等待线上确认", queued: "排队中", reading_snapshot: "读取商品快照", temp_submitting: "提交临时规格", temp_verified: "回读新 SKU", restoring: "恢复原数据", pattern_preparing: "准备新增花型", pattern_submitting: "提交新增花型", pattern_verifying: "回读新增花型", final_verifying: "最终回读校验", succeeded: "回读一致", paused: "已暂停", needs_manual_review: "待人工复核", failed: "处理失败",
  }[status] || status;
}

function taskResponse(task) {
  const { omsWriteStarted, subsidyWriteStarted, ...current } = task;
  return { ...current, operation: taskOperation(task), liveWriteStarted: externalWriteStarted(task), timeline: [...task.timeline] };
}

function externalWriteStarted(task) {
  return task?.liveWriteStarted === true || task?.omsWriteStarted === true || task?.subsidyWriteStarted === true;
}

function unresolvedLiveWrite(itemId, exceptTaskId) {
  return state.tasks.find((task) => task.itemId === String(itemId)
    && task.id !== exceptTaskId
    && externalWriteStarted(task)
    && task.status !== "succeeded");
}

const ACTIVE_TASK_STATUSES = new Set(["reading_snapshot", "temp_submitting", "temp_verified", "restoring", "pattern_preparing", "pattern_submitting", "pattern_verifying", "final_verifying"]);

function taskDeletionError(task, confirmation) {
  if (runningTaskIds.has(task.id) || ACTIVE_TASK_STATUSES.has(task.status)) {
    return "任务正在执行，必须等到当前阶段结束后才能删除";
  }
  if (task.mode === "live" && externalWriteStarted(task) && task.status !== "succeeded") {
    if (task.status !== "needs_manual_review" || confirmation !== MANUAL_REVIEW_CONFIRMATION) {
      return "任务已经进入天猫写入阶段；请先人工核对线上状态，再输入确认词解除锁定并删除";
    }
  }
  return null;
}

function removeTaskFromQueues(taskId) {
  for (const [batchId, taskIds] of scheduledRuns) {
    taskIds.delete(taskId);
    if (!taskIds.size) scheduledRuns.delete(batchId);
  }
  for (let index = pendingRuns.length - 1; index >= 0; index -= 1) {
    pendingRuns[index].taskIds = pendingRuns[index].taskIds.filter((idValue) => idValue !== taskId);
    if (!pendingRuns[index].taskIds.length) pendingRuns.splice(index, 1);
  }
}

function updateBatchAfterTaskRemoval(batch) {
  const batchTasks = state.tasks.filter((task) => task.batchId === batch.id);
  batch.taskIds = batchTasks.map((task) => task.id);
  batch.itemCount = batchTasks.length;
  batch.skuCount = batchTasks.reduce((sum, task) => sum + (taskOperation(task) === "add_pattern" ? (task.patternRows?.length || 0) : task.skuIds.length), 0);
  if (!batchTasks.length) return true;
  if (batch.status === "running") return false;
  const statuses = batchTasks.map((task) => task.status);
  if (statuses.every((status) => status === "succeeded")) batch.status = "succeeded";
  else if (statuses.some((status) => status === "succeeded")) batch.status = "partial";
  else if (statuses.some((status) => ["planned", "queued", "paused"].includes(status))) batch.status = "queued";
  else batch.status = "failed";
  return false;
}

function health() {
  const liveEnabled = process.env.TMALL_LIVE_ENABLED === "true";
  const contractConfigured = process.env.TMALL_LIVE_CONTRACT === "tmall-publish-v2";
  const missing = liveEnabled && !contractConfigured ? ["sku_rebuild", "add_pattern"] : [];
  const workflowConfigured = !liveEnabled || missing.length === 0;
  return {
    ready: true,
    mode: liveEnabled ? "live" : "demo",
    workerVersion: VERSION,
    browser: state.browser.visible ? "visible" : state.browser.hidden ? "hidden" : "stopped",
    profile: state.browser.profile,
    loggedIn: state.browser.loggedIn,
    riskRequired: state.browser.riskRequired,
    webdriver: state.browser.webdriver,
    workflow: { configured: workflowConfigured, missing },
    contract: liveEnabled ? (workflowConfigured ? "configured" : "missing") : "demo",
    unresolvedLiveWrites: state.tasks.filter((task) => externalWriteStarted(task) && task.status !== "succeeded").length,
    liveBatchConcurrency: LIVE_BATCH_CONCURRENCY,
    message: liveEnabled && !workflowConfigured
      ? "天猫商品写入契约未配置；未发出线上写请求"
      : liveEnabled ? "SKU ID 重建与新增花型流程已配置" : undefined,
  };
}

async function loadPlaywright() {
  try { return await import("playwright"); } catch { return null; }
}

function findEdgeExecutable() {
  const candidates = [
    process.env.TMALL_EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function edgeProcessRunning() {
  return !!edgeProcess && edgeProcess.exitCode == null && !edgeProcess.killed;
}

async function waitForCdp() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${BROWSER_CDP_PORT}/json/version`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw Object.assign(new Error("专属 Edge 已启动，但调试端口未就绪"), { code: "browser_connect_failed" });
}

async function cdpReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${BROWSER_CDP_PORT}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function dedicatedEdgeProcessExists() {
  const profile = state.browser.profile.replaceAll("'", "''");
  const portFlag = `--remote-debugging-port=${BROWSER_CDP_PORT}`;
  const command = `$profile='${profile}'; $portFlag='${portFlag}'; $count=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$profile*" -and $_.CommandLine -like "*$portFlag*" }).Count; Write-Output $count;`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return Number(String(result.stdout || "").trim()) > 0;
}

function setEdgeWindowVisible(visible) {
  const profile = state.browser.profile.replaceAll("'", "''");
  const command = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TmallWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@;
$profile = '${profile}';
$portFlag = '--remote-debugging-port=${BROWSER_CDP_PORT}';
$matched = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$profile*" -and $_.CommandLine -like "*$portFlag*" };
$changed = 0;
foreach ($entry in $matched) {
  $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue;
  if ($process -and $process.MainWindowHandle -ne 0) {
    [TmallWindow]::ShowWindowAsync($process.MainWindowHandle, ${visible ? 9 : 0}) | Out-Null;
    if (${visible ? "$true" : "$false"}) { [TmallWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null }
    $changed++;
  }
}
Write-Output $changed;`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return Number(String(result.stdout || "").trim()) > 0;
}

async function ensurePlaywrightBrowser({ visible }) {
  const playwright = await loadPlaywright();
  if (!playwright) throw Object.assign(new Error("未安装 Playwright；请先 npm install 并安装 Chromium"), { code: "playwright_missing" });
  fs.mkdirSync(state.browser.profile, { recursive: true });
  if (browserContext && !visible && browserPage) {
    const currentUrl = browserPage.url();
    state.browser.loggedIn = isLoggedInUrl(currentUrl);
  }
  if (browserContext) await browserContext.close().catch(() => {});
  const launchOptions = {
    headless: !visible,
    channel: process.env.TMALL_BROWSER_CHANNEL || "chromium",
    viewport: { width: 1440, height: 900 },
    args: visible ? [] : ["--disable-dev-shm-usage"],
  };
  try {
    browserContext = await playwright.chromium.launchPersistentContext(state.browser.profile, launchOptions);
  } catch (error) {
    if (process.platform !== "win32" || process.env.TMALL_BROWSER_CHANNEL) throw error;
    browserContext = await playwright.chromium.launchPersistentContext(state.browser.profile, { ...launchOptions, channel: "msedge" });
  }
  browserPage = browserContext.pages()[0] || await browserContext.newPage();
  if (visible && (!browserPage.url() || browserPage.url() === "about:blank")) {
    await browserPage.goto(process.env.TMALL_LOGIN_URL || DEFAULT_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  }
  state.browser.visible = visible;
  state.browser.hidden = !visible;
  saveState();
  return health();
}

async function openLoginBrowser() {
  if (process.platform !== "win32" || process.env.TMALL_BROWSER_STRATEGY === "playwright") {
    state.browser.strategy = "playwright";
    return ensurePlaywrightBrowser({ visible: true });
  }
  state.browser.strategy = "system-edge-cdp";
  fs.mkdirSync(state.browser.profile, { recursive: true });
  const portIsReady = await cdpReady();
  const dedicatedProcess = dedicatedEdgeProcessExists();
  if (edgeProcessRunning() || (portIsReady && dedicatedProcess)) {
    setEdgeWindowVisible(true);
    state.browser.visible = true;
    state.browser.hidden = false;
    saveState();
    return { ...health(), message: "已恢复专属 Edge 登录窗口" };
  }
  if (portIsReady && !dedicatedProcess) throw Object.assign(new Error(`CDP 端口 ${BROWSER_CDP_PORT} 已被其他进程占用`), { code: "cdp_port_in_use", status: 409 });
  if (!portIsReady && dedicatedProcess) throw Object.assign(new Error("专属 Profile 已被不带可用 CDP 的 Edge 占用"), { code: "profile_in_use", status: 409 });
  const executable = findEdgeExecutable();
  if (!executable) throw Object.assign(new Error("未找到 Microsoft Edge"), { code: "browser_not_found" });
  edgeProcess = spawn(executable, [
    `--user-data-dir=${state.browser.profile}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${BROWSER_CDP_PORT}`,
    `--remote-allow-origins=http://127.0.0.1:${BROWSER_CDP_PORT}`,
    process.env.TMALL_LOGIN_URL || DEFAULT_LOGIN_URL,
  ], { detached: true, stdio: "ignore", windowsHide: false });
  edgeProcess.unref();
  edgeProcess.once("exit", () => {
    edgeProcess = null;
    browserConnection = null;
    browserContext = null;
    browserPage = null;
    state.browser.visible = false;
    state.browser.hidden = false;
    state.browser.loggedIn = false;
    state.browser.riskRequired = false;
    state.browser.webdriver = null;
    saveState();
  });
  await waitForCdp();
  state.browser.visible = true;
  state.browser.hidden = false;
  state.browser.loggedIn = false;
  state.browser.riskRequired = false;
  state.browser.webdriver = null;
  saveState();
  return { ...health(), message: "请在专属 Edge 中手工完成登录；登录期间未附加 Playwright" };
}

async function connectSystemEdge() {
  const playwright = await loadPlaywright();
  if (!playwright) throw Object.assign(new Error("未安装 Playwright"), { code: "playwright_missing" });
  if (!browserConnection?.isConnected()) {
    await waitForCdp();
    browserConnection = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${BROWSER_CDP_PORT}`);
    browserConnection.once("disconnected", () => {
      browserConnection = null;
      browserContext = null;
      browserPage = null;
      state.browser.visible = false;
      state.browser.hidden = false;
      state.browser.loggedIn = false;
      state.browser.riskRequired = false;
      state.browser.webdriver = null;
      saveState();
    });
  }
  const pages = browserConnection.contexts().flatMap((context) => context.pages());
  browserPage = pages.find((page) => isLoggedInUrl(page.url())) || pages.find((page) => /tmall\.com|taobao\.com/.test(page.url())) || pages[0] || null;
  browserContext = browserPage?.context() || null;
  return browserPage;
}

function pageIsUsable(page) {
  return Boolean(page && !page.isClosed?.());
}

async function inspectBrowserPage(page) {
  if (!pageIsUsable(page)) return { url: "", bodyText: "", webdriver: null };
  const url = page.url();
  return page.evaluate(() => ({
    bodyText: (document.body?.innerText || "").slice(0, 12000),
    webdriver: navigator.webdriver,
  })).then((signals) => ({ url, ...signals })).catch(() => ({ url, bodyText: "", webdriver: null }));
}

async function verifyBrowser() {
  if (state.browser.strategy === "system-edge-cdp") await connectSystemEdge();
  if (!browserConnection && !browserContext) return { ...health(), message: "未找到专属浏览器页面" };
  const pages = browserConnection
    ? browserConnection.contexts().flatMap((context) => context.pages())
    : browserContext?.pages?.() || [];
  const sellerPage = pages.find((page) => isLoggedInUrl(page.url())) || browserPage;
  const sellerSignals = await inspectBrowserPage(sellerPage);
  const riskRequired = isRiskPage(sellerSignals.url, sellerSignals.bodyText);
  browserPage = sellerPage || browserPage;
  state.browser.riskRequired = riskRequired;
  state.browser.webdriver = sellerSignals.webdriver;
  state.browser.loggedIn = !riskRequired && isLoggedInUrl(sellerSignals.url);
  saveState();
  return {
    ...health(),
    currentUrl: sellerSignals.url,
    webdriver: sellerSignals.webdriver,
    message: riskRequired
      ? "检测到安全验证；请停止重复尝试，稍后手工处理"
      : `淘宝登录检查完成：${state.browser.loggedIn ? "会话有效" : "尚未验证"}`,
  };
}

async function hideBrowserWindow() {
  if (state.browser.strategy !== "system-edge-cdp") return ensurePlaywrightBrowser({ visible: false });
  const verified = await verifyBrowser();
  if (!verified.loggedIn) throw Object.assign(new Error("登录态尚未验证，不能隐藏登录窗口"), { code: "not_logged_in", status: 409 });
  if (!setEdgeWindowVisible(false)) throw Object.assign(new Error("未找到可隐藏的专属 Edge 窗口"), { code: "browser_window_not_found", status: 409 });
  state.browser.visible = false;
  state.browser.hidden = true;
  saveState();
  return { ...health(), currentUrl: verified.currentUrl, webdriver: verified.webdriver, message: "专属 Edge 保持有头运行，窗口已隐藏" };
}

function syntheticIds(task) {
  const digest = crypto.createHash("sha256").update(`${task.batchId}:${task.itemId}:${taskOperation(task)}`).digest("hex");
  const count = taskOperation(task) === "add_pattern"
    ? (task.patternRows?.length || 0)
    : task.skuIds.length || Number(task.expectedSkuCount) || 0;
  return Array.from({ length: count }, (_, index) => `demo-${digest.slice(index * 8, index * 8 + 10)}`);
}

async function runDemoTask(task) {
  const addPattern = taskOperation(task) === "add_pattern";
  const skuCountKnown = addPattern || task.skuIds.length > 0 || Number(task.expectedSkuCount) > 0;
  const stages = addPattern
    ? [
        ["reading_snapshot", "演练：读取商品快照并识别 Excel 组合", 20],
        ["pattern_preparing", "演练：区分现有组合和待新增组合", 45],
        ["pattern_submitting", "演练：生成单次新增花型提交计划", 70],
        ["pattern_verifying", "演练：保留最终服务端回读步骤", 95],
      ]
    : skuCountKnown
      ? [
          ["reading_snapshot", "已保存原始商品快照", 16],
          ["temp_submitting", "演练：生成临时规格请求计划", 38],
          ["temp_verified", "演练：临时 SKU 回读成功", 62],
          ["restoring", "演练：恢复原规格字段", 82],
          ["final_verifying", "演练：执行最终回读校验", 96],
        ]
      : [
          ["reading_snapshot", "演练：执行时将从商品快照读取 SKU", 16],
          ["temp_submitting", "演练：生成商品级临时规格计划", 38],
          ["temp_verified", "演练：保留新 SKU 回读校验步骤", 62],
          ["restoring", "演练：保留原规格恢复步骤", 82],
          ["final_verifying", "演练：保留最终字段校验步骤", 96],
        ];
  for (const [status, message, progress] of stages) {
    if (task.pauseRequested) {
      task.status = "paused";
      task.pauseRequested = false;
      addTimeline(task, "paused", "已在安全边界暂停", "warning");
      saveState();
      return;
    }
    task.status = status;
    task.progress = progress;
    addTimeline(task, status, message, "info");
    addAudit(task, status, { method: "DEMO", path: "worker://demo" });
    saveState();
    await sleep(180);
  }
  task.newSkuIds = syntheticIds(task);
  if (addPattern) task.addedSkuIds = [...task.newSkuIds];
  task.status = "succeeded";
  task.progress = 100;
  addTimeline(task, "final_verified", addPattern
    ? `演练完成：已生成 ${task.patternRows.length} 条 Excel 组合的新增计划`
    : skuCountKnown ? "演练完成：字段差异为 0" : "演练完成：SKU 数量将在真实快照读取后校验", "success");
  addAudit(task, "final_verified", { method: "DEMO", path: "worker://demo", status: 200, businessCode: "SUCCESS" });
  saveState();
}

async function runLiveTask(task) {
  const operation = taskOperation(task);
  if (process.env.TMALL_LIVE_ENABLED !== "true"
    || process.env.TMALL_LIVE_CONTRACT !== "tmall-publish-v2") {
    task.status = "needs_manual_review";
    task.errorCode = "workflow_contract_missing";
    task.errorMessage = `${operation === "add_pattern" ? "新增花型" : "SKU 重建"}契约尚未配置，未发出任何写请求`;
    task.progress = 0;
    addTimeline(task, "needs_manual_review", task.errorMessage, "warning");
    addAudit(task, "blocked", { method: "BLOCKED", path: "worker://workflow-contract", businessCode: task.errorCode });
    saveState();
    return;
  }
  try {
    const verified = await verifyBrowser();
    if (!verified.loggedIn || verified.riskRequired || verified.webdriver !== false) {
      throw Object.assign(new Error(verified.riskRequired ? "检测到安全验证，未发出写请求" : "浏览器登录态未通过安全校验，未发出写请求"), { code: verified.riskRequired ? "browser_risk_required" : "browser_not_verified" });
    }
    const page = await connectSystemEdge();
    if (!page) throw Object.assign(new Error("未找到专属 Edge 商品页"), { code: "browser_page_unavailable" });
    const phase = (entry) => {
      task.status = entry.phase;
      if (entry.progress != null) task.progress = entry.progress;
      addTimeline(task, entry.phase, entry.message, entry.level);
      addAudit(task, entry.phase, {
        method: "LOCAL",
        path: "worker://tmall-live-adapter",
        durationMs: entry.durationMs,
        elapsedMs: entry.elapsedMs,
      });
      saveState();
    };
    const execute = operation === "add_pattern" ? executeTmallAddPattern : executeTmallRebuild;
    const result = await execute(page, task, {
      onPhase(entry) { phase(entry); },
      onPatternPlan(entry) {
        task.existingCount = entry.existingCount;
        task.additionCount = entry.additionCount;
        task.patternPropertyKeys = entry.propertyKeys;
        saveState();
      },
      onSnapshot(entry) {
        if (entry.phase === "before") {
          task.oldSkuIds = entry.summary.skuIds;
          task.actualSkuCount = entry.summary.skuCount;
          if (operation === "sku_rebuild" && task.expectedSkuCount == null) task.expectedSkuCount = entry.summary.skuCount;
          task.snapshotBefore = entry.summary;
        } else if (entry.phase === "after") {
          task.newSkuIds = entry.summary.skuIds;
          task.snapshotAfter = entry.summary;
          task.fieldComparison = entry.comparison;
        } else {
          task.newSkuIds = entry.summary.skuIds;
        }
        saveState();
      },
      onRecoverySnapshot(snapshot) {
        task.recoverySnapshot = snapshot;
        saveState();
      },
      onWriteStart(entry) {
        task.liveWriteStarted = true;
        task.writePhase = entry.phase;
        saveState();
      },
      onNetwork(entry) {
        addAudit(task, entry.phase, { method: entry.method, path: entry.path, status: entry.status, businessCode: entry.classification?.businessCode });
        saveState();
      },
      withWriteLock(operation) {
        return withLiveWriteLock(operation);
      },
      readbackTiming: { streamHtml: true },
      onReadback(entry) {
        addAudit(task, entry.phase, {
          method: entry.method,
          path: entry.path,
          status: entry.status,
          durationMs: entry.durationMs,
          attempts: entry.attempts,
          deadlineMs: entry.deadlineMs,
          deadlineReadback: entry.deadlineReadback,
          strategy: entry.strategy,
          transport: entry.transport,
          polling: entry.polling,
          fastReadbackError: entry.fastReadbackError,
          businessCode: entry.settled ? "SUCCESS" : "PENDING",
        });
        saveState();
      },
    });
    task.oldSkuIds = result.oldSkuIds;
    task.newSkuIds = result.newSkuIds;
    task.skuMappings = result.skuMappings;
    task.addedSkuIds = result.addedSkuIds;
    task.existingSkuIds = result.existingSkuIds;
    task.existingCount = result.existingCount;
    task.additionCount = result.additionCount;
    task.status = "succeeded";
    task.progress = 100;
    task.errorCode = undefined;
    task.errorMessage = undefined;
    task.channelMigrationRequired = false;
    addTimeline(task, "succeeded", operation === "add_pattern"
      ? (result.additionCount
          ? `已保留 ${result.oldSkuIds.length} 个原 SKU，并新增 ${result.additionCount} 个花型组合，最终回读一致`
          : `Excel 中 ${result.existingCount} 个组合均已存在，已完成只读核对`)
      : `${result.skuCount} 个 SKU ID 已重建，原业务字段回读一致`, "success");
    addAudit(task, "final_verified", { method: "GET", path: "/tmall/publish.htm", status: 200, businessCode: "SUCCESS" });
    saveState();
  } catch (error) {
    task.status = "needs_manual_review";
    task.errorCode = error.code || "live_workflow_failed";
    task.errorMessage = error.message || "线上流程未能确认成功";
    if (["channel_option_migration_required", "channel_option_source_changed", "channel_option_not_offered"].includes(error.code) && !externalWriteStarted(task)) {
      task.channelMigrationRequired = true;
      task.channelOptionObserved = String(error.observedValue ?? "");
      task.channelOption = undefined;
      task.channelOptionSource = undefined;
      task.phaseLabel = "等待人工选择销售渠道";
      addTimeline(task, "needs_manual_review", `${task.errorMessage}。当前未发出预检或提交 POST，请核对当前渠道后确认重试`, "warning");
      addAudit(task, "channel_migration_required", {
        method: "GET",
        path: "/tmall/publish.htm",
        status: 200,
        businessCode: task.errorCode,
      });
    } else {
      const retryMessage = externalWriteStarted(task)
        ? `${task.errorMessage}。不会自动重试未知写入`
        : `${task.errorMessage}。写前校验已停止，未发出线上提交，不会自动重试`;
      addTimeline(task, "needs_manual_review", retryMessage, "error");
      addAudit(task, "blocked", { method: "BLOCKED", path: "worker://live-workflow", status: error.status, businessCode: error.businessCode || task.errorCode });
    }
    saveState();
  }
}

async function runBatch(batch, selectedTaskIds = batch.taskIds) {
  if (!selectedTaskIds.length) return;
  if (activeBatchId) {
    const pending = pendingRuns.find((entry) => entry.batchId === batch.id);
    if (pending) pending.taskIds = [...new Set([...pending.taskIds, ...selectedTaskIds])];
    else pendingRuns.push({ batchId: batch.id, taskIds: selectedTaskIds });
    return;
  }
  activeBatchId = batch.id;
  batch.status = "running";
  saveState();
  try {
    let nextIndex = 0;
    const runOne = async (taskId) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task || !["planned", "queued"].includes(task.status)) return;
      const conflictingWrite = task.mode === "live" ? unresolvedLiveWrite(task.itemId, task.id) : null;
      if (conflictingWrite) {
        task.status = "needs_manual_review";
        task.errorCode = "item_write_unresolved";
        task.errorMessage = `商品 ${task.itemId} 存在未确认的线上写入任务 ${conflictingWrite.id}，本任务未执行`;
        addTimeline(task, "needs_manual_review", task.errorMessage, "warning");
        addAudit(task, "blocked", { method: "BLOCKED", path: "worker://item-write-lock", businessCode: task.errorCode });
        saveState();
        return;
      }
      if (task.mode === "live" && externalWriteStarted(task)) {
        task.status = "needs_manual_review";
        task.errorCode = "manual_recovery_required";
        task.errorMessage = "任务已进入过天猫写入阶段，禁止自动重跑；请先核对服务端状态";
        addTimeline(task, "needs_manual_review", task.errorMessage, "warning");
        saveState();
        return;
      }
      task.status = "queued";
      task.attempts += 1;
      addTimeline(task, "queued", "已进入单商品写入队列", "info");
      saveState();
      runningTaskIds.add(task.id);
      try {
        if (batch.mode === "demo") await runDemoTask(task);
        else await runLiveTask(task);
      } finally {
        runningTaskIds.delete(task.id);
      }
    };
    const workerCount = Math.min(
      selectedTaskIds.length,
      batch.mode === "live" ? LIVE_BATCH_CONCURRENCY : 1,
    );
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= selectedTaskIds.length) return;
        await runOne(selectedTaskIds[index]);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const taskStates = batch.taskIds.map((idValue) => state.tasks.find((task) => task.id === idValue)?.status);
    batch.status = taskStates.every((status) => status === "succeeded") ? "succeeded" : taskStates.some((status) => status === "succeeded") ? "partial" : "failed";
    saveState();
  } finally {
    activeBatchId = null;
    const nextRun = pendingRuns.shift();
    if (nextRun && nextRun.taskIds.length) {
      const nextBatch = state.batches.find((entry) => entry.id === nextRun.batchId);
      if (nextBatch) queueMicrotask(() => runBatch(nextBatch, nextRun.taskIds));
    }
  }
}

function enqueueBatch(batch, selectedTaskIds = batch.taskIds) {
  if (activeBatchId) {
    const pending = pendingRuns.find((entry) => entry.batchId === batch.id);
    if (pending) pending.taskIds = [...new Set([...pending.taskIds, ...selectedTaskIds])];
    else pendingRuns.push({ batchId: batch.id, taskIds: selectedTaskIds });
    return;
  }
  const scheduled = scheduledRuns.get(batch.id);
  if (scheduled) {
    for (const taskId of selectedTaskIds) scheduled.add(taskId);
    return;
  }
  scheduledRuns.set(batch.id, new Set(selectedTaskIds));
  queueMicrotask(() => {
    const taskIds = [...(scheduledRuns.get(batch.id) || [])];
    scheduledRuns.delete(batch.id);
    runBatch(batch, taskIds);
  });
}

async function route(request, response) {
  const rid = requestId();
  const origin = request.headers.origin;
  response.__corsOrigin = origin && originAllowed(origin) ? origin : "null";
  if (!originAllowed(origin)) return json(response, 403, { error: "origin_not_allowed" }, rid);
  if (request.method === "OPTIONS") return json(response, 204, {}, rid);
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  try {
    if (request.method === "GET" && pathname === "/health") return json(response, 200, health(), rid);
    if (request.method === "GET" && pathname === "/tasks") {
      const operation = url.searchParams.get("operation");
      const tasks = operation ? state.tasks.filter((task) => taskOperation(task) === operation) : state.tasks;
      return json(response, 200, { tasks: tasks.map(taskResponse) }, rid);
    }
    if (request.method === "GET" && pathname === "/batches") {
      const operation = url.searchParams.get("operation");
      const batches = operation ? state.batches.filter((batch) => taskOperation(batch) === operation) : state.batches;
      return json(response, 200, { batches: batches.map((batch) => ({ ...batch, operation: taskOperation(batch) })) }, rid);
    }
    if (request.method === "GET" && pathname === "/audit/export") return json(response, 200, { exportedAt: now(), records: state.audit }, rid);
    if (request.method === "GET" && /^\/tasks\/[^/]+$/.test(pathname)) {
      const task = state.tasks.find((entry) => entry.id === pathname.split("/")[2]);
      return task ? json(response, 200, taskResponse(task), rid) : json(response, 404, { error: "task_not_found" }, rid);
    }
    if (request.method === "DELETE" && /^\/tasks\/[^/]+$/.test(pathname)) {
      const taskId = pathname.split("/")[2];
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return json(response, 404, { error: "task_not_found" }, rid);
      const payload = await body(request);
      const manuallyResolved = Boolean(task.mode === "live" && externalWriteStarted(task) && task.status === "needs_manual_review");
      const deletionError = taskDeletionError(task, payload.confirmation);
      if (deletionError) return json(response, 409, { error: manuallyResolved ? "manual_review_confirmation_required" : "task_not_deletable", message: deletionError }, rid);
      const batch = state.batches.find((entry) => entry.id === task.batchId);
      removeTaskFromQueues(task.id);
      addAudit(task, manuallyResolved ? "manual_review_resolved_and_deleted" : "deleted", {
        method: "DELETE",
        path: `/tasks/${task.id}`,
        status: 200,
        businessCode: manuallyResolved ? "TASK_MANUALLY_RESOLVED_AND_DELETED" : "TASK_DELETED",
      });
      state.tasks = state.tasks.filter((entry) => entry.id !== task.id);
      let removedBatch = false;
      if (batch) {
        removedBatch = updateBatchAfterTaskRemoval(batch);
        if (removedBatch) state.batches = state.batches.filter((entry) => entry.id !== batch.id);
      }
      saveState();
      return json(response, 200, { deleted: true, taskId: task.id, batchId: task.batchId, removedBatch, manuallyResolved }, rid);
    }
    if (request.method === "POST" && pathname === "/tasks") {
      const payload = await body(request);
      const operation = payload.operation ?? "sku_rebuild";
      const errors = validateItems(payload.items, operation);
      const mode = payload.mode === "live" ? "live" : "demo";
      if (mode === "live" && payload.confirmation !== confirmationFor(operation)) errors.push("线上模式需要确认词");
      if (errors.length) return json(response, 400, { error: "validation_error", errors }, rid);
      if (mode === "live") {
        const conflicts = payload.items
          .map((item) => unresolvedLiveWrite(String(item.itemId)))
          .filter(Boolean);
        if (conflicts.length) {
          return json(response, 409, {
            error: "item_write_unresolved",
            message: "商品存在未确认的线上写入，禁止创建新的线上任务",
            items: [...new Set(conflicts.map((task) => task.itemId))],
          }, rid);
        }
      }
      const batchId = id("batch");
      const createdAt = now();
      const taskIds = [];
      for (const item of payload.items) {
        const taskId = id("task");
        taskIds.push(taskId);
        const patternRows = operation === "add_pattern" ? normalizedPatternRows(item) : undefined;
        state.tasks.push({
          id: taskId,
          batchId,
          operation,
          itemId: String(item.itemId),
          skuIds: operation === "sku_rebuild" ? (item.skuIds || []).map(String) : [],
          expectedSkuCount: operation === "sku_rebuild" ? item.expectedSkuCount : undefined,
          ...(patternRows ? { patternRows } : {}),
          mode,
          status: "planned",
          phaseLabel: phaseFor("planned"),
          progress: 0,
          attempts: 0,
          createdAt,
          updatedAt: createdAt,
          timeline: [{
            at: createdAt,
            phase: "planned",
            message: mode === "demo"
              ? `${operation === "add_pattern" ? "新增花型" : "SKU 重建"}演练计划已生成`
              : `${operation === "add_pattern" ? "新增花型" : "SKU 重建"}线上任务已通过确认闸门`,
            level: "info",
          }],
        });
      }
      const batch = {
        id: batchId,
        operation,
        mode,
        confirmation: mode === "live",
        itemCount: payload.items.length,
        skuCount: payload.items.reduce((sum, item) => sum + (operation === "add_pattern" ? item.rows.length : (item.skuIds || []).length), 0),
        status: "queued",
        createdAt,
        taskIds,
      };
      state.batches.unshift(batch);
      saveState();
      if (mode === "demo") enqueueBatch(batch);
      return json(response, 201, { batchId, tasks: state.tasks.filter((task) => task.batchId === batchId).map(taskResponse) }, rid);
    }
    if (request.method === "POST" && /^\/batches\/[^/]+\/start$/.test(pathname)) {
      const batchId = pathname.split("/")[2];
      const batch = state.batches.find((entry) => entry.id === batchId);
      if (!batch) return json(response, 404, { error: "batch_not_found" }, rid);
      const payload = await body(request);
      if (batch.mode === "live" && payload.confirmation !== confirmationFor(taskOperation(batch))) return json(response, 400, { error: "confirmation_required" }, rid);
      if (batch.mode === "live" && batch.status !== "queued") return json(response, 409, { error: "batch_not_startable", message: "线上批次只能启动一次；请从任务状态判断后续处理" }, rid);
      if (batch.mode === "live") {
        const conflicts = batch.taskIds
          .map((taskId) => state.tasks.find((task) => task.id === taskId))
          .filter(Boolean)
          .filter((task) => (externalWriteStarted(task) && task.status !== "succeeded") || unresolvedLiveWrite(task.itemId, task.id));
        if (conflicts.length) {
          return json(response, 409, {
            error: "item_write_unresolved",
            message: "批次包含存在未确认线上写入的商品，禁止启动",
            items: [...new Set(conflicts.map((task) => task.itemId))],
          }, rid);
        }
        batch.status = "running";
        saveState();
      }
      enqueueBatch(batch);
      return json(response, 202, { accepted: true, batchId }, rid);
    }
    if (request.method === "POST" && /^\/tasks\/[^/]+\/(pause|retry)$/.test(pathname)) {
      const [, , taskId, action] = pathname.split("/");
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return json(response, 404, { error: "task_not_found" }, rid);
      const payload = await body(request);
      if (action === "pause") {
        if (task.mode === "live") return json(response, 409, { error: "live_task_not_pausable", message: "线上任务启动后必须完成恢复与回读，不能中途暂停" }, rid);
        if (["succeeded", "failed", "needs_manual_review"].includes(task.status)) return json(response, 409, { error: "task_not_running" }, rid);
        task.pauseRequested = true;
        addTimeline(task, "pause_requested", "已请求在下一个安全边界暂停", "warning");
      } else {
        if (!["failed", "needs_manual_review", "paused"].includes(task.status)) return json(response, 409, { error: "task_not_retryable" }, rid);
        if (task.mode === "live" && externalWriteStarted(task)) return json(response, 409, { error: "manual_recovery_required", message: "任务已进入过天猫写入阶段，禁止自动重跑；请先核对服务端状态" }, rid);
        if (task.mode === "live" && unresolvedLiveWrite(task.itemId, task.id)) return json(response, 409, { error: "item_write_unresolved", message: "同商品存在未确认的线上写入，禁止重试" }, rid);
        const migrationRequired = task.channelMigrationRequired === true
          || ["channel_option_migration_required", "channel_option_invalid", "channel_option_source_changed", "channel_option_not_offered"].includes(task.errorCode);
        if (migrationRequired) {
          const selectedChannel = normalizeChannelSelection(payload.channelOption);
          if (!selectedChannel) {
            return json(response, 409, {
              error: "channel_migration_required",
              message: "该商品的旧销售渠道无法自动映射，请明确选择 1（纯电商）或 2（商场同款）",
              observedValue: task.channelOptionObserved || "",
              options: Object.entries(CHANNEL_OPTION_LABELS).map(([value, label]) => ({ value, label })),
            }, rid);
          }
          if (payload.confirmChannelMigration !== true) {
            return json(response, 409, {
              error: "channel_migration_confirmation_required",
              message: `已选择 ${selectedChannel}（${channelLabel(selectedChannel)}），请确认后再重试`,
              channelOption: selectedChannel,
            }, rid);
          }
          task.channelOption = selectedChannel;
          task.channelOptionSource = task.channelOptionObserved;
          task.channelMigrationRequired = false;
          addTimeline(task, "channel_migration_confirmed", `已人工选择销售渠道 ${selectedChannel}（${channelLabel(selectedChannel)}），准备只重试本任务`, "warning");
        } else if (payload.channelOption !== undefined || payload.confirmChannelMigration !== undefined) {
          return json(response, 409, { error: "channel_migration_not_required", message: "该任务未等待销售渠道迁移，不能指定渠道" }, rid);
        }
        task.status = "queued";
        task.errorCode = undefined;
        task.errorMessage = undefined;
        task.phaseLabel = phaseFor("queued");
        task.progress = 0;
        addTimeline(task, "queued", "已重新加入队列", "info");
        const batch = state.batches.find((entry) => entry.id === task.batchId);
        if (batch) {
          batch.status = "queued";
          enqueueBatch(batch, [task.id]);
        }
      }
      saveState();
      return json(response, 202, { accepted: true }, rid);
    }
    if (request.method === "POST" && pathname === "/browser/login") {
      const result = await openLoginBrowser();
      return json(response, 200, result, rid);
    }
    if (request.method === "POST" && pathname === "/browser/hide") {
      const result = await hideBrowserWindow();
      return json(response, 200, result, rid);
    }
    if (request.method === "POST" && pathname === "/browser/verify") return json(response, 200, await verifyBrowser(), rid);
    return json(response, 404, { error: "not_found", path: pathname }, rid);
  } catch (error) {
    const code = error.code || "worker_error";
    return json(response, Number(error.status) || 500, { error: code, message: error.message }, rid);
  }
}

function recoverInterruptedTasks() {
  const recoverableStatuses = new Set(["queued", ...ACTIVE_TASK_STATUSES]);
  const recovered = [];
  for (const task of state.tasks) {
    if (!recoverableStatuses.has(task.status)) continue;
    const writeStarted = externalWriteStarted(task);
    task.status = "needs_manual_review";
    task.errorCode = writeStarted ? "manual_recovery_required" : "worker_restart_recovery_required";
    task.errorMessage = writeStarted
      ? "Worker 在天猫写入后重启，任务未完成最终确认；不会自动重试，请先核对服务端状态"
      : "Worker 重启时任务尚未完成；未自动恢复执行，请人工确认后重试或删除";
    addTimeline(task, "needs_manual_review", task.errorMessage, "warning");
    addAudit(task, "restart_recovery", {
      method: "LOCAL",
      path: "worker://restart-recovery",
      businessCode: task.errorCode,
    });
    recovered.push({ task, writeStarted });
  }
  if (!recovered.length) return;
  for (const batch of state.batches) {
    if (!recovered.some(({ task }) => task.batchId === batch.id)) continue;
    const batchTasks = state.tasks.filter((task) => task.batchId === batch.id);
    const statuses = batchTasks.map((task) => task.status);
    if (statuses.length && statuses.every((status) => status === "succeeded")) batch.status = "succeeded";
    else if (statuses.some((status) => status === "succeeded")) batch.status = "partial";
    else if (statuses.some((status) => ["planned", "queued", "paused"].includes(status))) batch.status = "queued";
    else batch.status = "failed";
  }
  saveState();
}

recoverInterruptedTasks();

const server = http.createServer(route);
server.listen(PORT, HOST, () => console.log(JSON.stringify({ ready: true, url: `http://${HOST}:${PORT}`, dataDir: DATA_DIR, mode: health().mode })));

function shutdown() {
  server.close(() => process.exit(0));
  if (state.browser.strategy === "playwright") browserContext?.close().catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
