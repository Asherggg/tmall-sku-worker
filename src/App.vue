<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Activity,
  Archive,
  ArrowDownToLine,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  FileUp,
  Gauge,
  Laptop2,
  ListChecks,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
} from "@lucide/vue";
import {
  browserAction,
  createBatch,
  deleteTask,
  exportAudit,
  getBatches,
  getHealth,
  getTasks,
  parseImport,
  pauseTask,
  retryTask,
  startBatch,
} from "./api";
import type { BatchRecord, ImportPreview, TaskRecord, WorkerHealth } from "./types";

type View = "overview" | "import" | "queue" | "browser" | "audit";
const EXPECTED_WORKER_VERSION = "0.1.16";
const LIVE_CONFIRMATION = "确认线上重建";
const PREVIEW_ITEM_LIMIT = 10;

const view = ref<View>("overview");
const health = ref<WorkerHealth>({ ready: false, mode: "demo", workerVersion: "-", browser: "unavailable", profile: "-", loggedIn: false, contract: "demo" });
const tasks = ref<TaskRecord[]>([]);
const batches = ref<BatchRecord[]>([]);
const selectedTask = ref<TaskRecord | null>(null);
const drawerOpen = ref(false);
const importText = ref("828872681901");
const isRefreshing = ref(false);
const isSubmitting = ref(false);
let refreshTimer: number | undefined;

const preview = computed<ImportPreview>(() => parseImport(importText.value));
const visiblePreviewItems = computed(() => preview.value.items.slice(0, PREVIEW_ITEM_LIMIT));
const hiddenPreviewItemCount = computed(() => Math.max(0, preview.value.items.length - PREVIEW_ITEM_LIMIT));
const liveRuntimeReady = computed(() => health.value.ready
  && health.value.workerVersion === EXPECTED_WORKER_VERSION
  && health.value.mode === "live"
  && health.value.contract === "configured");
const liveRuntimeMessage = computed(() => {
  if (!health.value.ready) return "Worker 未启动，不能执行线上任务";
  if (health.value.workerVersion !== EXPECTED_WORKER_VERSION) return `当前连接的是旧 Worker ${health.value.workerVersion}，请退出旧版后重新打开 0.1.16`;
  if (health.value.mode !== "live" || health.value.contract !== "configured") return "当前 Worker 未启用 tmall-publish-v2 纯接口适配器";
  return "";
});
const hasPendingSkuLookup = computed(() => preview.value.items.some((item) => !item.skuIds.length && item.expectedSkuCount == null));
const runningTasks = computed(() => tasks.value.filter((task) => ["queued", "reading_snapshot", "temp_submitting", "temp_verified", "restoring", "final_verifying"].includes(task.status)));
const succeededTasks = computed(() => tasks.value.filter((task) => task.status === "succeeded"));
const reviewTasks = computed(() => tasks.value.filter((task) => ["needs_manual_review", "failed"].includes(task.status)));
const activeBatch = computed(() => batches.value.find((batch) => ["queued", "running", "partial"].includes(batch.status)) || batches.value[0]);

const navItems = [
  { id: "overview" as const, label: "总览", icon: Gauge },
  { id: "import" as const, label: "批量导入", icon: Upload },
  { id: "queue" as const, label: "任务队列", icon: ListChecks },
  { id: "browser" as const, label: "浏览器登录", icon: Laptop2 },
  { id: "audit" as const, label: "审计记录", icon: Archive },
];

async function refresh(silent = false) {
  if (!silent) isRefreshing.value = true;
  try {
    const [nextHealth, nextTasks, nextBatches] = await Promise.all([getHealth(), getTasks(), getBatches()]);
    health.value = nextHealth;
    tasks.value = nextTasks;
    batches.value = nextBatches;
    if (selectedTask.value) {
      const current = nextTasks.find((task) => task.id === selectedTask.value?.id);
      selectedTask.value = current || null;
      if (!current) drawerOpen.value = false;
    }
  } finally {
    if (!silent) isRefreshing.value = false;
  }
}

async function handleCreateBatch() {
  if (!preview.value.valid || isSubmitting.value) return;
  if (!liveRuntimeReady.value) {
    ElMessage.error(liveRuntimeMessage.value);
    return;
  }
  try {
    const scope = hasPendingSkuLookup.value
      ? `${preview.value.items.length} 个商品，SKU 数将在读取快照后确认`
      : `${preview.value.items.length} 个商品、${preview.value.skuCount} 个 SKU`;
    await ElMessageBox.confirm(`将创建线上批次处理 ${scope}。线上写入不可自动撤回，是否继续？`, "线上写入确认", { type: "warning", confirmButtonText: "继续", cancelButtonText: "取消" });
  } catch {
    return;
  }
  isSubmitting.value = true;
  try {
    await createBatch(preview.value.items, "live", LIVE_CONFIRMATION);
    ElMessage.success("线上批次已进入队列");
    view.value = "queue";
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "创建批次失败");
  } finally {
    isSubmitting.value = false;
  }
}

async function handleStartBatch() {
  if (!activeBatch.value) return;
  try {
    await startBatch(activeBatch.value.id, LIVE_CONFIRMATION);
    ElMessage.success("批次已启动");
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "启动失败");
  }
}

async function handlePause(task: TaskRecord) {
  try {
    await pauseTask(task.id);
    ElMessage.success("已请求在安全边界暂停");
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "暂停失败");
  }
}

async function handleRetry(task: TaskRecord) {
  try {
    await retryTask(task.id);
    ElMessage.success("已加入重试队列");
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "重试失败");
  }
}

function canDeleteTask(task: TaskRecord) {
  return !["reading_snapshot", "temp_submitting", "temp_verified", "restoring", "final_verifying"].includes(task.status);
}

async function handleDelete(task: TaskRecord) {
  if (!canDeleteTask(task)) {
    ElMessage.warning("任务正在执行，不能删除");
    return;
  }
  try {
    const needsManualResolution = task.mode === "live" && task.liveWriteStarted && task.status === "needs_manual_review";
    let deletionConfirmation: string | undefined;
    if (needsManualResolution) {
      const result = await ElMessageBox.prompt(
        `该任务已经发出过线上写入。删除只会解除本地锁定，不会撤销天猫变更。请先核对商品 ${task.itemId} 的线上规格，再输入：确认已人工核对`,
        "解除人工复核锁定并删除",
        {
          type: "warning",
          confirmButtonText: "解除锁定并删除",
          cancelButtonText: "取消",
          inputPlaceholder: "确认已人工核对",
          inputValidator: (value) => value === "确认已人工核对" || "确认词不正确",
        },
      );
      deletionConfirmation = result.value;
    } else {
      await ElMessageBox.confirm(`删除商品 ${task.itemId} 的任务？删除后会从任务队列移除，但审计记录仍会保留。`, "删除任务", {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
      });
    }
    const result = await deleteTask(task.id, deletionConfirmation);
    if (selectedTask.value?.id === task.id) {
      selectedTask.value = null;
      drawerOpen.value = false;
    }
    ElMessage.success(result.manuallyResolved ? "人工复核锁定已解除，任务已删除" : "任务已删除");
    await refresh();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "删除任务失败");
  }
}

async function handleBrowser(action: "login" | "hide" | "verify") {
  try {
    health.value = await browserAction(action);
    if (health.value.riskRequired) ElMessage.warning(health.value.message || "检测到安全验证，请停止重复尝试");
    else if (action === "verify" && !health.value.loggedIn) ElMessage.warning(health.value.message || "尚未验证登录态");
    else ElMessage.success(action === "login" ? "已打开未附加自动化的专属 Edge" : action === "hide" ? "Edge 保持有头运行，窗口已隐藏" : health.value.webdriver === false ? "登录态有效，webdriver 未开启" : "登录态检查完成");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "浏览器操作失败");
  }
}

async function handleExportAudit() {
  try {
    const payload = await exportAudit();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tmall-audit-${new Date().toISOString().replaceAll(":", "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    ElMessage.success("审计记录已导出");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "导出失败");
  }
}

function statusLabel(status: TaskRecord["status"]) {
  const labels: Record<TaskRecord["status"], string> = {
    draft: "草稿", validated: "已校验", planned: "已计划", awaiting_confirmation: "待确认", queued: "排队中", reading_snapshot: "读取快照", temp_submitting: "临时提交", temp_verified: "临时已回读", restoring: "恢复原数据", final_verifying: "最终回读", succeeded: "已完成", paused: "已暂停", needs_manual_review: "人工复核", failed: "失败",
  };
  return labels[status];
}

function statusType(status: TaskRecord["status"]) {
  if (status === "succeeded") return "success";
  if (["needs_manual_review", "failed"].includes(status)) return "danger";
  if (["queued", "paused", "awaiting_confirmation"].includes(status)) return "warning";
  return "primary";
}

function skuCountLabel(item: { skuIds: string[]; expectedSkuCount?: number; oldSkuIds?: string[] }) {
  const count = item.oldSkuIds?.length || item.skuIds.length || item.expectedSkuCount;
  return count ? String(count) : "待读取";
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function openTask(task: TaskRecord) {
  selectedTask.value = task;
  drawerOpen.value = true;
}

onMounted(async () => {
  await refresh();
  refreshTimer = window.setInterval(() => refresh(true), 4000);
});

onUnmounted(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand-lockup">
        <div class="brand-mark"><Activity :size="18" /></div>
        <div><strong>Tmall SKU Worker</strong><span>批量重建控制台</span></div>
      </div>
      <nav class="primary-nav" aria-label="主导航">
        <button v-for="item in navItems" :key="item.id" class="nav-item" :class="{ active: view === item.id }" @click="view = item.id">
          <component :is="item.icon" :size="17" />
          <span>{{ item.label }}</span>
          <span v-if="item.id === 'queue' && runningTasks.length" class="nav-count">{{ runningTasks.length }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <div class="profile-chip"><UserRound :size="16" /><span>{{ health.loggedIn ? "店铺会话有效" : "等待登录" }}</span><i :class="['dot', health.loggedIn ? 'ok' : 'muted']" /></div>
        <small>Worker {{ health.workerVersion }}</small>
      </div>
    </aside>

    <main class="main-area">
      <header class="topbar">
        <div><span class="eyebrow">WORKSPACE / {{ view.toUpperCase() }}</span><h1>{{ navItems.find((item) => item.id === view)?.label }}</h1></div>
        <div class="top-actions">
          <span class="connection-state"><i :class="['dot', health.ready ? 'ok' : 'warn']" />{{ health.ready ? "Worker 在线" : "Worker 离线" }}</span>
          <button class="icon-button" title="刷新状态" :disabled="isRefreshing" @click="refresh()"><RefreshCw :size="17" :class="{ spinning: isRefreshing }" /></button>
        </div>
      </header>

      <section v-if="view === 'overview'" class="content-view">
        <div class="status-banner" :class="health.loggedIn ? 'positive' : 'attention'">
          <div class="banner-icon"><ShieldCheck :size="20" /></div>
          <div><strong>{{ health.loggedIn ? "浏览器会话已准备" : "浏览器尚未登录" }}</strong><p>{{ health.message || (health.loggedIn ? "专属 Edge 保持有头运行，窗口已隐藏" : "首次运行请打开专属 Edge 手工完成登录") }}</p></div>
          <button class="text-button" @click="view = 'browser'">查看会话 <ArrowDownToLine :size="15" /></button>
        </div>
        <div class="metric-grid">
          <div class="metric"><span>批次总数</span><strong>{{ batches.length }}</strong><small>本地队列</small></div>
          <div class="metric"><span>处理中</span><strong>{{ runningTasks.length }}</strong><small>按商品串行</small></div>
          <div class="metric"><span>已完成</span><strong>{{ succeededTasks.length }}</strong><small>已回读校验</small></div>
          <div class="metric warning-metric"><span>待复核</span><strong>{{ reviewTasks.length }}</strong><small>未知或不一致</small></div>
        </div>
        <div class="section-heading"><div><span class="eyebrow">ACTIVE BATCH</span><h2>最近任务</h2></div><button class="outline-button" @click="view = 'queue'">查看队列 <ListChecks :size="15" /></button></div>
        <div class="table-frame">
          <el-table :data="tasks.slice(0, 6)" empty-text="还没有任务" table-layout="fixed">
            <el-table-column prop="itemId" label="商品 ID" width="150" />
            <el-table-column label="SKU 数" width="90"><template #default="scope"><span class="mono">{{ skuCountLabel(scope.row) }}</span></template></el-table-column>
            <el-table-column label="模式" width="100"><template #default="scope"><el-tag size="small" :type="scope.row.mode === 'demo' ? 'info' : 'danger'">{{ scope.row.mode === 'demo' ? '演练' : '线上' }}</el-tag></template></el-table-column>
            <el-table-column label="阶段"><template #default="scope"><div class="phase-cell"><el-tag size="small" :type="statusType(scope.row.status)">{{ statusLabel(scope.row.status) }}</el-tag><span>{{ scope.row.phaseLabel }}</span></div></template></el-table-column>
            <el-table-column label="进度" width="180"><template #default="scope"><el-progress :percentage="scope.row.progress" :status="scope.row.status === 'succeeded' ? 'success' : undefined" :stroke-width="6" /></template></el-table-column>
            <el-table-column label="更新时间" width="120"><template #default="scope"><span class="muted-text">{{ formatTime(scope.row.updatedAt) }}</span></template></el-table-column>
          </el-table>
        </div>
      </section>

      <section v-else-if="view === 'import'" class="content-view narrow-view">
        <div class="page-intro"><span class="eyebrow">BATCH INPUT</span><h2>导入商品任务</h2><p>按商品分组；同一商品的 SKU 会在一个安全队列中处理。</p></div>
        <div class="import-layout">
          <div class="panel import-panel">
            <div class="panel-head"><div><h3>商品 ID</h3><span>每行一个</span></div><FileUp :size="18" /></div>
            <el-input v-model="importText" type="textarea" :rows="12" resize="none" placeholder="828872681901&#10;下一行继续填写" />
            <div class="format-hint"><span class="mono">828872681901</span><span>兼容原 CSV 格式</span></div>
            <div v-if="preview.errors.length" class="validation-errors"><CircleAlert :size="16" /><div><strong>需要修正 {{ preview.errors.length }} 项</strong><ul><li v-for="error in preview.errors" :key="error">{{ error }}</li></ul></div></div>
          </div>
          <div class="panel preview-panel">
            <div class="panel-head"><div><h3>批次预览</h3><span>创建前检查</span></div><ClipboardList :size="18" /></div>
            <div class="preview-stat"><span>商品数</span><strong>{{ preview.items.length }}</strong></div>
            <div class="preview-stat"><span>SKU 数</span><strong>{{ hasPendingSkuLookup ? '待读取' : preview.skuCount }}</strong></div>
            <div class="preview-items"><div v-for="item in visiblePreviewItems" :key="item.itemId" class="preview-item"><span class="mono">{{ item.itemId }}</span><span>{{ skuCountLabel(item) }} SKU</span></div><span v-if="!preview.items.length" class="empty-copy">导入后显示商品分组</span></div><div v-if="hiddenPreviewItemCount" class="preview-overflow-note">仅显示前 {{ PREVIEW_ITEM_LIMIT }} 个商品，另有 {{ hiddenPreviewItemCount }} 个未展开</div>
            <div class="mode-switch"><span>运行模式</span><el-tag type="danger" size="small">线上</el-tag></div>
            <span v-if="!liveRuntimeReady" class="error-line">{{ liveRuntimeMessage }}</span>
            <button class="primary-button full-button" :disabled="!preview.valid || isSubmitting || !liveRuntimeReady" @click="handleCreateBatch"><Play :size="16" />{{ isSubmitting ? '创建中…' : '创建线上批次' }}</button>
          </div>
        </div>
      </section>

      <section v-else-if="view === 'queue'" class="content-view">
        <div class="section-heading"><div><span class="eyebrow">QUEUE</span><h2>任务队列</h2></div><div class="heading-actions"><button class="outline-button" @click="view = 'import'"><Upload :size="15" />新建批次</button><button v-if="activeBatch && activeBatch.status === 'queued'" class="primary-button" @click="handleStartBatch"><Play :size="15" />启动队列</button></div></div>
        <div class="queue-toolbar"><span>{{ tasks.length }} 个商品任务</span><span class="toolbar-divider" /><span>同商品不并发写入</span><span class="toolbar-spacer" /><el-tag v-if="health.unresolvedLiveWrites" type="danger" size="small">{{ health.unresolvedLiveWrites }} 个线上写入待核对</el-tag><el-tag v-else-if="health.contract === 'missing'" type="warning" size="small">线上适配器未配置</el-tag></div>
        <div class="table-frame queue-table">
          <el-table :data="tasks" empty-text="还没有任务" table-layout="fixed" @row-click="openTask">
            <el-table-column prop="itemId" label="商品 ID" width="165" />
            <el-table-column label="原 SKU" width="130"><template #default="scope"><span class="mono">{{ skuCountLabel(scope.row) }}</span></template></el-table-column>
            <el-table-column label="模式" width="90"><template #default="scope"><el-tag size="small" :type="scope.row.mode === 'demo' ? 'info' : 'danger'">{{ scope.row.mode === 'demo' ? '演练' : '线上' }}</el-tag></template></el-table-column>
            <el-table-column label="状态" width="150"><template #default="scope"><el-tag size="small" :type="statusType(scope.row.status)">{{ statusLabel(scope.row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="阶段"><template #default="scope"><span>{{ scope.row.phaseLabel }}</span><small v-if="scope.row.errorMessage" class="error-line">{{ scope.row.errorMessage }}</small></template></el-table-column>
            <el-table-column label="进度" width="170"><template #default="scope"><el-progress :percentage="scope.row.progress" :status="scope.row.status === 'succeeded' ? 'success' : undefined" :stroke-width="6" /></template></el-table-column>
            <el-table-column label="操作" width="220"><template #default="scope"><div class="row-actions"><button v-if="scope.row.mode === 'demo' && runningTasks.includes(scope.row)" class="table-icon" title="暂停" @click.stop="handlePause(scope.row)"><Pause :size="15" /></button><button v-if="['failed','needs_manual_review'].includes(scope.row.status) && !(scope.row.mode === 'live' && scope.row.liveWriteStarted)" class="table-icon" title="重试" @click.stop="handleRetry(scope.row)"><RotateCcw :size="15" /></button><el-tag v-if="scope.row.mode === 'live' && scope.row.liveWriteStarted && scope.row.status === 'needs_manual_review'" type="danger" size="small">需核对后删除</el-tag><button v-if="canDeleteTask(scope.row)" class="table-icon delete-task-button" title="删除任务" @click.stop="handleDelete(scope.row)"><Trash2 :size="15" /></button><button class="table-icon" title="查看详情" @click.stop="openTask(scope.row)"><ArrowDownToLine :size="15" /></button></div></template></el-table-column>
          </el-table>
        </div>
      </section>

      <section v-else-if="view === 'browser'" class="content-view narrow-view">
        <div class="page-intro"><span class="eyebrow">BROWSER SESSION</span><h2>浏览器登录</h2><p>使用应用专属 Profile，不接管日常 Edge。</p></div>
        <div class="browser-status panel"><div class="browser-orb" :class="health.loggedIn ? 'online' : ''"><Laptop2 :size="30" /></div><div class="browser-copy"><h3>{{ health.riskRequired ? '需要人工验证' : health.loggedIn ? '会话有效' : '需要登录' }}</h3><p>{{ health.riskRequired ? '已检测到安全验证，当前不会继续尝试' : health.loggedIn ? '专属 Edge 仍以正常有头模式运行' : '登录阶段不附加 Playwright，不切换无头模式' }}</p><div class="status-lines"><span><i :class="['dot', health.loggedIn ? 'ok' : 'warn']" />登录态：{{ health.loggedIn ? '有效' : health.riskRequired ? '验证阻断' : '未验证' }}</span><span><i :class="['dot', health.browser === 'hidden' ? 'ok' : 'muted']" />浏览器：{{ health.browser === 'hidden' ? '窗口已隐藏' : health.browser === 'visible' ? '可见登录' : '未启动' }}</span><span><i class="dot muted" />Profile：<span class="mono">{{ health.profile }}</span></span><span v-if="health.webdriver !== undefined"><i :class="['dot', health.webdriver === false ? 'ok' : 'warn']" />webdriver：{{ health.webdriver === false ? '关闭' : health.webdriver === true ? '开启' : '未知' }}</span></div></div><div class="browser-actions"><button class="primary-button" @click="handleBrowser('login')"><UserRound :size="16" />打开登录窗口</button><button class="outline-button" @click="handleBrowser('verify')"><ShieldCheck :size="16" />我已登录，检查状态</button><button class="ghost-button" @click="handleBrowser('hide')">隐藏窗口</button></div></div>
        <div class="notice-block"><CircleAlert :size="17" /><div><strong>出现连续滑块时请停止重试</strong><p>关闭旧登录页，稍后在新的专属 Profile 中手工完成一次验证；Worker 不会操作滑块。</p></div></div>
      </section>

      <section v-else class="content-view">
        <div class="section-heading"><div><span class="eyebrow">AUDIT</span><h2>审计记录</h2></div><button class="outline-button" title="导出脱敏记录" @click="handleExportAudit"><ArrowDownToLine :size="15" />导出 JSON</button></div>
        <div class="audit-summary"><div><span>留存内容</span><strong>快照、阶段、回读</strong></div><div><span>敏感字段</span><strong>已脱敏</strong></div><div><span>任务总数</span><strong>{{ tasks.length }}</strong></div></div>
        <div class="table-frame"><el-table :data="tasks" empty-text="暂无审计记录" table-layout="fixed"><el-table-column prop="itemId" label="商品 ID" width="170" /><el-table-column label="结果" width="130"><template #default="scope"><el-tag size="small" :type="statusType(scope.row.status)">{{ statusLabel(scope.row.status) }}</el-tag></template></el-table-column><el-table-column label="原 → 新 SKU"><template #default="scope"><span class="mono">{{ scope.row.oldSkuIds?.join(', ') || '待生成' }} → {{ scope.row.newSkuIds?.join(', ') || '—' }}</span></template></el-table-column><el-table-column label="最后更新时间" width="150"><template #default="scope">{{ formatTime(scope.row.updatedAt) }}</template></el-table-column><el-table-column label="详情" width="90"><template #default="scope"><button class="table-icon" title="查看时间线" @click="openTask(scope.row)"><ArrowDownToLine :size="15" /></button></template></el-table-column></el-table></div>
      </section>
    </main>

    <el-drawer v-model="drawerOpen" title="任务详情" size="460px" destroy-on-close>
      <template v-if="selectedTask">
        <div class="drawer-summary"><span class="eyebrow">ITEM TASK</span><strong class="mono">{{ selectedTask.itemId }}</strong><el-tag :type="statusType(selectedTask.status)">{{ statusLabel(selectedTask.status) }}</el-tag></div>
        <div class="drawer-grid"><div><span>模式</span><strong>{{ selectedTask.mode === 'demo' ? '演练' : '线上' }}</strong></div><div><span>进度</span><strong>{{ selectedTask.progress }}%</strong></div><div><span>原 SKU</span><strong>{{ skuCountLabel(selectedTask) }}</strong></div><div><span>新 SKU</span><strong>{{ selectedTask.newSkuIds?.length || '—' }}</strong></div></div>
        <div class="timeline"><div v-for="entry in selectedTask.timeline" :key="entry.at + entry.phase" class="timeline-entry"><i :class="['timeline-dot', entry.level]" /><div><small>{{ formatTime(entry.at) }} · {{ entry.phase }}</small><p>{{ entry.message }}</p></div></div><div v-if="!selectedTask.timeline.length" class="empty-copy">尚无阶段记录</div></div>
        <button v-if="canDeleteTask(selectedTask)" class="ghost-button delete-drawer-button" @click="handleDelete(selectedTask)"><Trash2 :size="15" />删除任务</button>
      </template>
    </el-drawer>
  </div>
</template>
