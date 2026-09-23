<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowDownToLine,
  CheckCircle2,
  CircleAlert,
  FileSpreadsheet,
  Laptop2,
  ListChecks,
  Palette,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserRound,
} from "@lucide/vue";
import {
  browserAction,
  createAddPatternBatch,
  deleteTask,
  getBatches,
  getHealth,
  getTasks,
  retryTask,
  startBatch,
} from "../api";
import { parsePatternWorkbook } from "../pattern-workbook.ts";
import ChannelMigrationDialog from "../components/ChannelMigrationDialog.vue";
import type { BatchRecord, ChannelOption, PatternImportPreview, TaskRecord, TaskStatus, WorkerHealth } from "../types";

type View = "import" | "queue" | "browser";
const props = withDefaults(defineProps<{ initialView?: View; launchToken?: number }>(), {
  initialView: "import",
  launchToken: 0,
});

const EXPECTED_WORKER_VERSION = "0.1.31";
const LIVE_CONFIRMATION = "确认线上新增花型";
const MAX_VISIBLE_ROWS = 80;
const ACTIVE_STATUSES: TaskStatus[] = ["queued", "reading_snapshot", "pattern_preparing", "pattern_submitting", "pattern_verifying"];

const view = ref<View>(props.initialView);
const health = ref<WorkerHealth>({ ready: false, mode: "demo", workerVersion: "-", browser: "unavailable", profile: "-", loggedIn: false, contract: "demo" });
const tasks = ref<TaskRecord[]>([]);
const batches = ref<BatchRecord[]>([]);
const preview = ref<PatternImportPreview | null>(null);
const fileName = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const dragActive = ref(false);
const isParsing = ref(false);
const isRefreshing = ref(false);
const isSubmitting = ref(false);
const selectedTask = ref<TaskRecord | null>(null);
const drawerOpen = ref(false);
const migrationTask = ref<TaskRecord | null>(null);
const migrationDialogOpen = ref(false);
const isMigrating = ref(false);
let refreshTimer: number | undefined;

const liveRuntimeReady = computed(() => health.value.ready
  && health.value.workerVersion === EXPECTED_WORKER_VERSION
  && health.value.mode === "live"
  && health.value.contract === "configured");
const liveRuntimeMessage = computed(() => {
  if (!health.value.ready) return "Worker 未启动，不能执行线上任务";
  if (health.value.workerVersion !== EXPECTED_WORKER_VERSION) return `当前连接的是旧 Worker ${health.value.workerVersion}，请退出旧版后重新打开 ${EXPECTED_WORKER_VERSION}`;
  if (health.value.mode !== "live" || health.value.contract !== "configured") return health.value.message || "当前 Worker 运行资源未就绪";
  return "";
});
const visibleRows = computed(() => preview.value?.rows.slice(0, MAX_VISIBLE_ROWS) || []);
const hiddenRowCount = computed(() => Math.max(0, (preview.value?.rows.length || 0) - MAX_VISIBLE_ROWS));
const runningTasks = computed(() => tasks.value.filter((task) => ACTIVE_STATUSES.includes(task.status)));
const reviewTasks = computed(() => tasks.value.filter((task) => ["needs_manual_review", "failed"].includes(task.status)));
const succeededTasks = computed(() => tasks.value.filter((task) => task.status === "succeeded"));
const activeBatch = computed(() => batches.value.find((batch) => ["queued", "running", "partial"].includes(batch.status)) || null);

const navItems = [
  { id: "import" as const, label: "导入花型", icon: FileSpreadsheet },
  { id: "queue" as const, label: "任务队列", icon: ListChecks },
  { id: "browser" as const, label: "浏览器登录", icon: Laptop2 },
];

async function refresh(silent = false) {
  if (!silent) isRefreshing.value = true;
  try {
    const [nextHealth, nextTasks, nextBatches] = await Promise.all([
      getHealth(),
      getTasks("add_pattern"),
      getBatches("add_pattern"),
    ]);
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

async function parseFile(file: File) {
  if (!/\.xlsx$/i.test(file.name)) {
    ElMessage.error("请选择 .xlsx 文件");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    ElMessage.error("Excel 文件不能超过 10 MB");
    return;
  }
  isParsing.value = true;
  try {
    preview.value = await parsePatternWorkbook(await file.arrayBuffer());
    fileName.value = file.name;
    if (preview.value.valid) ElMessage.success(`已读取 ${preview.value.items.length} 个商品、${preview.value.requestedCount} 条组合`);
    else ElMessage.error("Excel 校验未通过");
  } catch (error) {
    preview.value = null;
    fileName.value = "";
    ElMessage.error(error instanceof Error ? error.message : "Excel 读取失败");
  } finally {
    isParsing.value = false;
  }
}

function handleFileInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void parseFile(file);
  input.value = "";
}

function handleDrop(event: DragEvent) {
  dragActive.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void parseFile(file);
}

async function handleCreateBatch() {
  if (!preview.value?.canSubmit || isSubmitting.value) return;
  if (!liveRuntimeReady.value) {
    ElMessage.error(liveRuntimeMessage.value);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将核对 ${preview.value.items.length} 个商品、${preview.value.requestedCount} 条 Excel 组合。线上已存在的组合只读核对，缺少的组合将新增；每个商品最多提交一次。`,
      "新增花型线上确认",
      { type: "warning", confirmButtonText: "创建批次", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  isSubmitting.value = true;
  try {
    await createAddPatternBatch(preview.value.items, "live", LIVE_CONFIRMATION);
    ElMessage.success("新增花型批次已创建");
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

function needsChannelMigration(task: TaskRecord) {
  return task.channelMigrationRequired === true
    || ["channel_option_migration_required", "channel_option_invalid", "channel_option_source_changed", "channel_option_not_offered"].includes(task.errorCode || "");
}

async function handleRetry(task: TaskRecord) {
  if (needsChannelMigration(task)) {
    migrationTask.value = task;
    migrationDialogOpen.value = true;
    return;
  }
  try {
    await retryTask(task.id);
    ElMessage.success("已重新加入队列");
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "重试失败");
  }
}

async function handleChannelMigration(channelOption: ChannelOption) {
  if (!migrationTask.value || isMigrating.value) return;
  isMigrating.value = true;
  try {
    await retryTask(migrationTask.value.id, channelOption, true);
    ElMessage.success(`已选择 ${channelOption}，当前商品已重新加入队列`);
    migrationDialogOpen.value = false;
    migrationTask.value = null;
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "渠道迁移重试失败");
  } finally {
    isMigrating.value = false;
  }
}

function canDeleteTask(task: TaskRecord) {
  return !ACTIVE_STATUSES.includes(task.status);
}

async function handleDelete(task: TaskRecord) {
  if (!canDeleteTask(task)) return;
  try {
    let confirmation: string | undefined;
    if (task.mode === "live" && task.liveWriteStarted && task.status === "needs_manual_review") {
      const result = await ElMessageBox.prompt(
        `该任务已发出线上写入。请先核对商品 ${task.itemId}，再输入：确认已人工核对`,
        "解除人工复核锁定并删除",
        {
          type: "warning",
          confirmButtonText: "解除锁定并删除",
          cancelButtonText: "取消",
          inputPlaceholder: "确认已人工核对",
          inputValidator: (value) => value === "确认已人工核对" || "确认词不正确",
        },
      );
      confirmation = result.value;
    } else {
      await ElMessageBox.confirm(`删除商品 ${task.itemId} 的新增花型任务？`, "删除任务", {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
      });
    }
    await deleteTask(task.id, confirmation);
    if (selectedTask.value?.id === task.id) drawerOpen.value = false;
    ElMessage.success("任务已删除");
    await refresh();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "删除任务失败");
  }
}

async function handleBrowser(action: "login" | "hide" | "verify") {
  try {
    health.value = await browserAction(action);
    if (health.value.riskRequired) ElMessage.warning(health.value.message || "检测到安全验证");
    else if (action === "verify" && !health.value.loggedIn) ElMessage.warning(health.value.message || "尚未验证登录态");
    else ElMessage.success(action === "login" ? "已打开专属 Edge" : action === "hide" ? "Edge 窗口已隐藏" : health.value.message || "登录态检查完成");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "浏览器操作失败");
  }
}

function statusLabel(status: TaskStatus) {
  const labels: Record<TaskStatus, string> = {
    draft: "草稿", validated: "已校验", planned: "已计划", awaiting_confirmation: "待确认", queued: "排队中",
    reading_snapshot: "读取快照", temp_submitting: "临时提交", temp_verified: "临时已回读", restoring: "恢复原数据",
    pattern_preparing: "准备花型", pattern_submitting: "提交花型", pattern_verifying: "回读花型",
    final_verifying: "最终回读", succeeded: "已完成", paused: "已暂停", needs_manual_review: "人工复核", failed: "失败",
  };
  return labels[status];
}

function statusType(status: TaskStatus) {
  if (status === "succeeded") return "success";
  if (["needs_manual_review", "failed"].includes(status)) return "danger";
  if (["queued", "paused", "awaiting_confirmation"].includes(status)) return "warning";
  return "primary";
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function openTask(task: TaskRecord) {
  selectedTask.value = task;
  drawerOpen.value = true;
}

watch(() => props.launchToken, () => {
  view.value = props.initialView;
});

onMounted(async () => {
  await refresh();
  refreshTimer = window.setInterval(() => refresh(true), 4000);
});

onUnmounted(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="app-shell pattern-app-shell">
    <aside class="sidebar pattern-sidebar">
      <div class="brand-lockup">
        <div class="brand-mark pattern-mark"><Palette :size="18" /></div>
        <div><strong>新增花型</strong><span>天猫运营工作台应用</span></div>
      </div>
      <nav class="primary-nav" aria-label="新增花型导航">
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
        <div><span class="eyebrow">PATTERN / {{ view.toUpperCase() }}</span><h1>{{ navItems.find((item) => item.id === view)?.label }}</h1></div>
        <div class="top-actions">
          <span class="connection-state"><i :class="['dot', health.ready ? 'ok' : 'warn']" />{{ health.ready ? "Worker 在线" : "Worker 离线" }}</span>
          <button class="icon-button" title="刷新状态" :disabled="isRefreshing" @click="refresh()"><RefreshCw :size="17" :class="{ spinning: isRefreshing }" /></button>
        </div>
      </header>

      <section v-if="view === 'import'" class="content-view pattern-import-view">
        <div class="section-heading">
          <div><span class="eyebrow">XLSX INPUT</span><h2>Excel 组合清单</h2></div>
          <span v-if="fileName" class="selected-file"><FileSpreadsheet :size="15" />{{ fileName }}</span>
        </div>

        <div class="pattern-upload-grid">
          <div class="panel pattern-upload-panel">
            <input ref="fileInput" class="visually-hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="handleFileInput" />
            <button
              class="pattern-dropzone"
              :class="{ active: dragActive, loaded: preview?.valid }"
              :disabled="isParsing"
              @click="fileInput?.click()"
              @dragenter.prevent="dragActive = true"
              @dragover.prevent="dragActive = true"
              @dragleave.prevent="dragActive = false"
              @drop.prevent="handleDrop"
            >
              <span class="dropzone-icon"><UploadCloud :size="26" /></span>
              <strong>{{ isParsing ? "正在读取 Excel" : preview ? "重新选择 Excel" : "选择 Excel 文件" }}</strong>
              <small>.xlsx · 最大 10 MB</small>
            </button>
            <div class="pattern-columns" aria-label="Excel 必填列">
              <span v-for="column in ['商品ID','规格','颜色分类','价格','数量','商家编码','条形码','备注']" :key="column">{{ column }}</span>
            </div>
            <div v-if="preview?.errors.length" class="validation-errors pattern-validation">
              <CircleAlert :size="16" />
              <div><strong>{{ preview.errors.length }} 项阻断错误</strong><ul><li v-for="error in preview.errors" :key="error">{{ error }}</li></ul></div>
            </div>
            <div v-if="preview?.warnings.length" class="pattern-warnings">
              <CircleAlert :size="15" />
              <div><p v-for="warning in preview.warnings" :key="warning">{{ warning }}</p></div>
            </div>
          </div>

          <div class="panel pattern-summary-panel">
            <div class="panel-head"><div><h3>批次摘要</h3><span>{{ preview?.sheetName || '等待文件' }}</span></div><CheckCircle2 :size="18" /></div>
            <div class="pattern-summary-row"><span>商品数</span><strong>{{ preview?.items.length || 0 }}</strong></div>
            <div class="pattern-summary-row"><span>Excel 组合</span><strong>{{ preview?.requestedCount || 0 }}</strong></div>
            <div class="pattern-summary-row"><span>运行模式</span><el-tag type="danger" size="small">线上</el-tag></div>
            <div class="pattern-rule"><ShieldCheck :size="16" /><span>现有组合只读核对；缺少组合单次提交后严格回读</span></div>
            <span v-if="!liveRuntimeReady" class="error-line">{{ liveRuntimeMessage }}</span>
            <button class="primary-button full-button pattern-primary" :disabled="!preview?.canSubmit || isSubmitting || !liveRuntimeReady" @click="handleCreateBatch">
              <Play :size="16" />{{ isSubmitting ? '创建中…' : '创建线上批次' }}
            </button>
          </div>
        </div>

        <div v-if="preview?.rows.length" class="pattern-preview-section">
          <div class="section-heading compact-heading"><div><span class="eyebrow">ROW PREVIEW</span><h2>组合预览</h2></div><span class="muted-text">{{ preview.rows.length }} 行</span></div>
          <div class="table-frame pattern-preview-table">
            <el-table :data="visibleRows" table-layout="fixed">
              <el-table-column prop="sourceRow" label="行" width="58" />
              <el-table-column prop="itemId" label="商品 ID" width="142" />
              <el-table-column prop="specification" label="规格" min-width="170" show-overflow-tooltip />
              <el-table-column prop="color" label="颜色分类" min-width="210" show-overflow-tooltip />
              <el-table-column prop="price" label="价格" width="92" />
              <el-table-column prop="quantity" label="数量" width="72" />
              <el-table-column prop="merchantCode" label="商家编码" width="115" />
              <el-table-column prop="barcode" label="条形码" width="145" />
              <el-table-column prop="remark" label="备注" min-width="150" show-overflow-tooltip />
            </el-table>
          </div>
          <div v-if="hiddenRowCount" class="preview-overflow-note">仅显示前 {{ MAX_VISIBLE_ROWS }} 行，另有 {{ hiddenRowCount }} 行未展开</div>
        </div>
      </section>

      <section v-else-if="view === 'queue'" class="content-view">
        <div class="metric-grid pattern-metrics">
          <div class="metric"><span>批次总数</span><strong>{{ batches.length }}</strong><small>新增花型</small></div>
          <div class="metric"><span>处理中</span><strong>{{ runningTasks.length }}</strong><small>最多 {{ health.liveBatchConcurrency || 1 }} 路</small></div>
          <div class="metric"><span>已完成</span><strong>{{ succeededTasks.length }}</strong><small>服务端已回读</small></div>
          <div class="metric warning-metric"><span>待复核</span><strong>{{ reviewTasks.length }}</strong><small>禁止自动重写</small></div>
        </div>
        <div class="section-heading"><div><span class="eyebrow">PATTERN QUEUE</span><h2>商品任务</h2></div><div class="heading-actions"><button class="outline-button" @click="view = 'import'"><FileSpreadsheet :size="15" />导入 Excel</button><button v-if="activeBatch?.status === 'queued'" class="primary-button pattern-primary" @click="handleStartBatch"><Play :size="15" />启动队列</button></div></div>
        <div class="queue-toolbar"><span>{{ tasks.length }} 个商品任务</span><span class="toolbar-divider" /><span>最多两路读取/回读，线上提交全局串行</span><span class="toolbar-spacer" /><el-tag v-if="health.unresolvedLiveWrites" type="danger" size="small">{{ health.unresolvedLiveWrites }} 个线上写入待核对</el-tag></div>
        <div class="table-frame queue-table">
          <el-table :data="tasks" empty-text="还没有新增花型任务" table-layout="fixed" @row-click="openTask">
            <el-table-column prop="itemId" label="商品 ID" width="155" />
            <el-table-column label="Excel 组合" width="100"><template #default="scope"><span class="mono">{{ scope.row.patternRows?.length || 0 }}</span></template></el-table-column>
            <el-table-column label="现有 / 新增" width="120"><template #default="scope"><span>{{ scope.row.existingCount ?? '—' }} / {{ scope.row.additionCount ?? '—' }}</span></template></el-table-column>
            <el-table-column label="状态" width="130"><template #default="scope"><el-tag size="small" :type="statusType(scope.row.status)">{{ statusLabel(scope.row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="阶段"><template #default="scope"><span>{{ scope.row.phaseLabel }}</span><small v-if="scope.row.errorMessage" class="error-line">{{ scope.row.errorMessage }}</small></template></el-table-column>
            <el-table-column label="进度" width="155"><template #default="scope"><el-progress :percentage="scope.row.progress" :status="scope.row.status === 'succeeded' ? 'success' : undefined" :stroke-width="6" /></template></el-table-column>
            <el-table-column label="操作" width="145"><template #default="scope"><div class="row-actions"><button v-if="['failed','needs_manual_review'].includes(scope.row.status) && !scope.row.liveWriteStarted" class="table-icon" :title="needsChannelMigration(scope.row) ? '选择销售渠道并重试' : '重试'" @click.stop="handleRetry(scope.row)"><RotateCcw :size="15" /></button><button v-if="canDeleteTask(scope.row)" class="table-icon delete-task-button" title="删除任务" @click.stop="handleDelete(scope.row)"><Trash2 :size="15" /></button><button class="table-icon" title="查看详情" @click.stop="openTask(scope.row)"><ArrowDownToLine :size="15" /></button></div></template></el-table-column>
          </el-table>
        </div>
      </section>

      <section v-else class="content-view narrow-view">
        <div class="page-intro"><span class="eyebrow">BROWSER SESSION</span><h2>浏览器登录</h2><p>新增花型复用工作台专属 Profile 和同一登录会话。</p></div>
        <div class="browser-status panel"><div class="browser-orb" :class="health.loggedIn ? 'online' : ''"><Laptop2 :size="30" /></div><div class="browser-copy"><h3>{{ health.riskRequired ? '需要人工验证' : health.loggedIn ? '会话有效' : '需要登录' }}</h3><p>{{ health.riskRequired ? '已检测到安全验证，当前不会继续尝试' : health.loggedIn ? '专属 Edge 仍以正常有头模式运行' : '登录阶段不附加 Playwright' }}</p><div class="status-lines"><span><i :class="['dot', health.loggedIn ? 'ok' : 'warn']" />淘宝登录态：{{ health.loggedIn ? '有效' : '未验证' }}</span><span><i :class="['dot', health.webdriver === false ? 'ok' : 'warn']" />webdriver：{{ health.webdriver === false ? '关闭' : '未知' }}</span><span><i class="dot muted" />Profile：<span class="mono">{{ health.profile }}</span></span></div></div><div class="browser-actions"><button class="primary-button pattern-primary" @click="handleBrowser('login')"><UserRound :size="16" />打开登录窗口</button><button class="outline-button" @click="handleBrowser('verify')"><ShieldCheck :size="16" />检查淘宝登录</button><button class="ghost-button" @click="handleBrowser('hide')">隐藏窗口</button></div></div>
      </section>
    </main>

    <el-drawer v-model="drawerOpen" title="新增花型任务详情" size="470px" destroy-on-close>
      <template v-if="selectedTask">
        <div class="drawer-summary"><span class="eyebrow">PATTERN TASK</span><strong class="mono">{{ selectedTask.itemId }}</strong><el-tag :type="statusType(selectedTask.status)">{{ statusLabel(selectedTask.status) }}</el-tag></div>
        <div class="drawer-grid"><div><span>Excel 组合</span><strong>{{ selectedTask.patternRows?.length || 0 }}</strong></div><div><span>进度</span><strong>{{ selectedTask.progress }}%</strong></div><div><span>线上已存在</span><strong>{{ selectedTask.existingCount ?? '—' }}</strong></div><div><span>实际新增</span><strong>{{ selectedTask.addedSkuIds?.length ?? selectedTask.additionCount ?? '—' }}</strong></div></div>
        <div v-if="needsChannelMigration(selectedTask)" class="channel-drawer-action"><CircleAlert :size="16" /><div><strong>需要选择新的销售渠道</strong><p>旧值“{{ selectedTask.channelOptionObserved || '空值' }}”已被平台废弃。</p></div><button class="primary-button pattern-primary" @click="handleRetry(selectedTask)"><RotateCcw :size="15" />选择并重试</button></div>
        <div v-if="selectedTask.addedSkuIds?.length" class="added-id-list"><span>新增 SKU ID</span><strong class="mono">{{ selectedTask.addedSkuIds.join(', ') }}</strong></div>
        <div class="timeline"><div v-for="entry in selectedTask.timeline" :key="entry.at + entry.phase" class="timeline-entry"><i :class="['timeline-dot', entry.level]" /><div><small>{{ formatTime(entry.at) }} · {{ entry.phase }}</small><p>{{ entry.message }}</p></div></div></div>
        <button v-if="canDeleteTask(selectedTask)" class="ghost-button delete-drawer-button" @click="handleDelete(selectedTask)"><Trash2 :size="15" />删除任务</button>
      </template>
    </el-drawer>

    <ChannelMigrationDialog v-model="migrationDialogOpen" :task="migrationTask" :pending="isMigrating" @confirm="handleChannelMigration" />
  </div>
</template>
