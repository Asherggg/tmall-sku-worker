<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import type { Component, CSSProperties } from "vue";
import {
  Activity,
  Clock3,
  Laptop2,
  LayoutGrid,
  ListChecks,
  Maximize2,
  Minus,
  Palette,
  ShieldCheck,
  Wifi,
  X,
} from "@lucide/vue";
import { getHealth, getTasks } from "./api";
import AddPatternApp from "./apps/AddPatternApp.vue";
import SkuRebuildApp from "./apps/SkuRebuildApp.vue";
import type { TaskRecord, WorkerHealth } from "./types";

type AppId = "sku-rebuild" | "add-pattern";
type SkuView = "overview" | "import" | "queue" | "browser" | "audit";
type PatternView = "import" | "queue" | "browser";
type ShortcutId = AppId | "task-center" | "browser-session";

interface Shortcut {
  id: ShortcutId;
  label: string;
  icon: Component;
  appId: AppId;
  view: SkuView | PatternView;
  tone: "teal" | "blue" | "amber" | "rose";
}

interface AppWindowState {
  open: boolean;
  minimized: boolean;
  maximized: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

const shortcuts: Shortcut[] = [
  { id: "sku-rebuild", label: "SKU ID 重建", icon: Activity, appId: "sku-rebuild", view: "overview", tone: "teal" },
  { id: "add-pattern", label: "新增花型", icon: Palette, appId: "add-pattern", view: "import", tone: "rose" },
  { id: "task-center", label: "任务中心", icon: ListChecks, appId: "sku-rebuild", view: "queue", tone: "blue" },
  { id: "browser-session", label: "浏览器会话", icon: Laptop2, appId: "sku-rebuild", view: "browser", tone: "amber" },
];

const desktopSurface = ref<HTMLElement | null>(null);
const skuWindowElement = ref<HTMLElement | null>(null);
const patternWindowElement = ref<HTMLElement | null>(null);
const selectedShortcut = ref<ShortcutId | null>(null);
const skuLaunchView = ref<SkuView>("overview");
const skuLaunchToken = ref(0);
const patternLaunchView = ref<PatternView>("import");
const patternLaunchToken = ref(0);
const now = ref(new Date());
const runtime = reactive({
  health: {
    ready: false,
    mode: "demo",
    workerVersion: "-",
    browser: "unavailable",
    profile: "-",
    loggedIn: false,
    contract: "demo",
  } as WorkerHealth,
  tasks: [] as TaskRecord[],
});
const windows = reactive<Record<AppId, AppWindowState>>({
  "sku-rebuild": { open: false, minimized: false, maximized: false, x: 64, y: 72, width: 1160, height: 680, zIndex: 20 },
  "add-pattern": { open: false, minimized: false, maximized: false, x: 92, y: 58, width: 1180, height: 700, zIndex: 21 },
});
let topZIndex = 21;
let clockTimer: number | undefined;
let runtimeTimer: number | undefined;
let windowResizeObserver: ResizeObserver | undefined;
let dragState: { appId: AppId; offsetX: number; offsetY: number } | null = null;

const runningStatuses = new Set(["queued", "reading_snapshot", "temp_submitting", "temp_verified", "restoring", "pattern_preparing", "pattern_submitting", "pattern_verifying", "final_verifying"]);
const runningTasks = computed(() => runtime.tasks.filter((task) => runningStatuses.has(task.status)));
const reviewTasks = computed(() => runtime.tasks.filter((task) => ["needs_manual_review", "failed"].includes(task.status)));
const dateLabel = computed(() => new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(now.value));
const timeLabel = computed(() => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now.value));
const sessionLabel = computed(() => {
  if (runtime.health.riskRequired) return "需要人工验证";
  if (!runtime.health.loggedIn) return "等待登录";
  return "店铺会话有效";
});

function taskOperation(task: TaskRecord) {
  return task.operation === "add_pattern" ? "add_pattern" : "sku_rebuild";
}

function windowStyle(appId: AppId): CSSProperties {
  const state = windows[appId];
  if (state.maximized) return { zIndex: state.zIndex };
  return {
    left: `${state.x}px`,
    top: `${state.y}px`,
    width: `${state.width}px`,
    height: `${state.height}px`,
    zIndex: state.zIndex,
  };
}

function shortcutBadge(id: ShortcutId) {
  if (id === "task-center") return runningTasks.value.length || reviewTasks.value.length || 0;
  if (id === "add-pattern") return runtime.tasks.filter((task) => taskOperation(task) === "add_pattern" && runningStatuses.has(task.status)).length;
  if (id === "browser-session" && runtime.health.riskRequired) return "!";
  return 0;
}

function bringToFront(appId: AppId) {
  topZIndex += 1;
  windows[appId].zIndex = topZIndex;
}

function launchShortcut(shortcut: Shortcut) {
  selectedShortcut.value = shortcut.id;
  if (shortcut.appId === "sku-rebuild") {
    skuLaunchView.value = shortcut.view as SkuView;
    skuLaunchToken.value += 1;
  } else {
    patternLaunchView.value = shortcut.view as PatternView;
    patternLaunchToken.value += 1;
  }
  const state = windows[shortcut.appId];
  state.open = true;
  state.minimized = false;
  bringToFront(shortcut.appId);
  fitWindowToDesktop(shortcut.appId);
}

function showDesktop() {
  for (const state of Object.values(windows)) {
    if (state.open && !state.minimized) state.minimized = true;
  }
}

function toggleTaskbarApp(appId: AppId) {
  const state = windows[appId];
  if (!state.open) {
    launchShortcut(shortcuts.find((shortcut) => shortcut.appId === appId) as Shortcut);
    return;
  }
  if (state.minimized) {
    state.minimized = false;
    bringToFront(appId);
    return;
  }
  const highestVisibleZ = Math.max(...Object.values(windows).filter((entry) => entry.open && !entry.minimized).map((entry) => entry.zIndex));
  if (state.zIndex === highestVisibleZ) state.minimized = true;
  else bringToFront(appId);
}

function closeAppWindow(appId: AppId) {
  windows[appId].open = false;
  windows[appId].minimized = false;
}

function toggleMaximize(appId: AppId) {
  windows[appId].maximized = !windows[appId].maximized;
  bringToFront(appId);
}

function fitWindowToDesktop(appId?: AppId) {
  const surface = desktopSurface.value;
  if (!surface) return;
  const bounds = surface.getBoundingClientRect();
  const appIds: AppId[] = appId ? [appId] : ["sku-rebuild", "add-pattern"];
  for (const id of appIds) {
    const state = windows[id];
    if (state.maximized) continue;
    state.width = Math.min(state.width, Math.max(900, bounds.width - 32));
    state.height = Math.min(state.height, Math.max(560, bounds.height - 32));
    state.x = Math.min(Math.max(16, state.x), Math.max(16, bounds.width - state.width - 16));
    state.y = Math.min(Math.max(16, state.y), Math.max(16, bounds.height - state.height - 16));
  }
}

function startWindowDrag(appId: AppId, event: PointerEvent) {
  if (windows[appId].maximized || (event.target as HTMLElement).closest("button")) return;
  bringToFront(appId);
  dragState = { appId, offsetX: event.clientX - windows[appId].x, offsetY: event.clientY - windows[appId].y };
  document.body.classList.add("window-dragging");
  window.addEventListener("pointermove", moveWindow);
  window.addEventListener("pointerup", stopWindowDrag, { once: true });
}

function moveWindow(event: PointerEvent) {
  if (!dragState || !desktopSurface.value) return;
  const bounds = desktopSurface.value.getBoundingClientRect();
  const state = windows[dragState.appId];
  const nextX = event.clientX - bounds.left - dragState.offsetX;
  const nextY = event.clientY - bounds.top - dragState.offsetY;
  state.x = Math.min(Math.max(0, nextX), Math.max(0, bounds.width - 180));
  state.y = Math.min(Math.max(0, nextY), Math.max(0, bounds.height - 42));
}

function stopWindowDrag() {
  dragState = null;
  document.body.classList.remove("window-dragging");
  window.removeEventListener("pointermove", moveWindow);
}

async function refreshRuntime() {
  const [health, tasks] = await Promise.all([getHealth(), getTasks()]);
  runtime.health = health;
  runtime.tasks = tasks;
}

onMounted(() => {
  fitWindowToDesktop();
  windowResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      const appId = target.dataset.appWindow as AppId;
      const state = windows[appId];
      const bounds = target.getBoundingClientRect();
      if (!state || state.maximized || bounds.width < 1 || bounds.height < 1) continue;
      state.width = Math.round(bounds.width);
      state.height = Math.round(bounds.height);
    }
  });
  if (skuWindowElement.value) windowResizeObserver.observe(skuWindowElement.value);
  if (patternWindowElement.value) windowResizeObserver.observe(patternWindowElement.value);
  void refreshRuntime();
  runtimeTimer = window.setInterval(refreshRuntime, 4000);
  clockTimer = window.setInterval(() => { now.value = new Date(); }, 30_000);
  window.addEventListener("resize", () => fitWindowToDesktop());
});

onUnmounted(() => {
  if (clockTimer) window.clearInterval(clockTimer);
  if (runtimeTimer) window.clearInterval(runtimeTimer);
  windowResizeObserver?.disconnect();
  window.removeEventListener("pointermove", moveWindow);
});
</script>

<template>
  <div class="workbench-shell">
    <main ref="desktopSurface" class="desktop-surface" @click.self="selectedShortcut = null">
      <header class="desktop-brand" aria-label="工作台信息">
        <div class="workbench-mark"><LayoutGrid :size="22" /></div>
        <div><span>TMALL OPERATIONS</span><h1>天猫运营工作台</h1></div>
      </header>

      <div class="desktop-status" aria-live="polite">
        <span><i :class="['dot', runtime.health.ready ? 'ok' : 'warn']" />{{ runtime.health.ready ? 'Worker 在线' : 'Worker 离线' }}</span>
        <span><ShieldCheck :size="14" />{{ sessionLabel }}</span>
        <span><ListChecks :size="14" />{{ runningTasks.length }} 个任务处理中</span>
      </div>

      <nav class="desktop-shortcuts" aria-label="桌面应用">
        <button
          v-for="shortcut in shortcuts"
          :key="shortcut.id"
          class="desktop-shortcut"
          :class="{ selected: selectedShortcut === shortcut.id }"
          :aria-label="`打开${shortcut.label}`"
          :title="shortcut.label"
          @click.stop="selectedShortcut = shortcut.id"
          @dblclick.stop="launchShortcut(shortcut)"
          @keydown.enter.prevent="launchShortcut(shortcut)"
        >
          <span :class="['shortcut-icon', shortcut.tone]">
            <component :is="shortcut.icon" :size="28" :stroke-width="1.8" />
            <b v-if="shortcutBadge(shortcut.id)" class="shortcut-badge">{{ shortcutBadge(shortcut.id) }}</b>
          </span>
          <span>{{ shortcut.label }}</span>
        </button>
      </nav>

      <section class="desktop-summary" aria-label="运行摘要">
        <div><span>今日</span><strong>{{ dateLabel }}</strong></div>
        <div><span>任务</span><strong>{{ runtime.tasks.length }} 个</strong></div>
        <div :class="{ attention: reviewTasks.length > 0 }"><span>待复核</span><strong>{{ reviewTasks.length }} 个</strong></div>
      </section>

      <section
        ref="skuWindowElement"
        v-show="windows['sku-rebuild'].open && !windows['sku-rebuild'].minimized"
        data-app-window="sku-rebuild"
        class="workbench-window"
        :class="{ maximized: windows['sku-rebuild'].maximized }"
        :style="windowStyle('sku-rebuild')"
        aria-label="SKU ID 重建应用窗口"
        @pointerdown="bringToFront('sku-rebuild')"
      >
        <header class="window-titlebar" @pointerdown="startWindowDrag('sku-rebuild', $event)" @dblclick="toggleMaximize('sku-rebuild')">
          <span class="window-app-icon"><Activity :size="15" /></span><strong>SKU ID 重建</strong><span class="window-context">天猫运营工作台</span>
          <div class="window-controls">
            <button title="最小化 SKU ID 重建" aria-label="最小化 SKU ID 重建" @dblclick.stop @click.stop="windows['sku-rebuild'].minimized = true"><Minus :size="16" /></button>
            <button :title="windows['sku-rebuild'].maximized ? '还原 SKU ID 重建' : '最大化 SKU ID 重建'" :aria-label="windows['sku-rebuild'].maximized ? '还原 SKU ID 重建' : '最大化 SKU ID 重建'" @dblclick.stop @click.stop="toggleMaximize('sku-rebuild')"><Maximize2 :size="14" /></button>
            <button class="window-close" title="关闭 SKU ID 重建" aria-label="关闭 SKU ID 重建" @dblclick.stop @click.stop="closeAppWindow('sku-rebuild')"><X :size="16" /></button>
          </div>
        </header>
        <div class="window-content"><SkuRebuildApp :initial-view="skuLaunchView" :launch-token="skuLaunchToken" /></div>
      </section>

      <section
        ref="patternWindowElement"
        v-show="windows['add-pattern'].open && !windows['add-pattern'].minimized"
        data-app-window="add-pattern"
        class="workbench-window pattern-workbench-window"
        :class="{ maximized: windows['add-pattern'].maximized }"
        :style="windowStyle('add-pattern')"
        aria-label="新增花型应用窗口"
        @pointerdown="bringToFront('add-pattern')"
      >
        <header class="window-titlebar" @pointerdown="startWindowDrag('add-pattern', $event)" @dblclick="toggleMaximize('add-pattern')">
          <span class="window-app-icon pattern-window-icon"><Palette :size="15" /></span><strong>新增花型</strong><span class="window-context">天猫运营工作台</span>
          <div class="window-controls">
            <button title="最小化 新增花型" aria-label="最小化 新增花型" @dblclick.stop @click.stop="windows['add-pattern'].minimized = true"><Minus :size="16" /></button>
            <button :title="windows['add-pattern'].maximized ? '还原 新增花型' : '最大化 新增花型'" :aria-label="windows['add-pattern'].maximized ? '还原 新增花型' : '最大化 新增花型'" @dblclick.stop @click.stop="toggleMaximize('add-pattern')"><Maximize2 :size="14" /></button>
            <button class="window-close" title="关闭 新增花型" aria-label="关闭 新增花型" @dblclick.stop @click.stop="closeAppWindow('add-pattern')"><X :size="16" /></button>
          </div>
        </header>
        <div class="window-content"><AddPatternApp :initial-view="patternLaunchView" :launch-token="patternLaunchToken" /></div>
      </section>
    </main>

    <footer class="workbench-taskbar">
      <button class="taskbar-home" title="显示桌面" aria-label="显示桌面" @click="showDesktop"><LayoutGrid :size="19" /></button>
      <span class="taskbar-divider" />
      <button v-if="windows['sku-rebuild'].open" class="taskbar-app" :class="{ active: !windows['sku-rebuild'].minimized }" title="SKU ID 重建" @click="toggleTaskbarApp('sku-rebuild')"><Activity :size="16" /><span>SKU ID 重建</span><i v-if="runtime.tasks.some((task) => taskOperation(task) === 'sku_rebuild' && runningStatuses.has(task.status))" class="taskbar-running" /></button>
      <button v-if="windows['add-pattern'].open" class="taskbar-app pattern-taskbar-app" :class="{ active: !windows['add-pattern'].minimized }" title="新增花型" @click="toggleTaskbarApp('add-pattern')"><Palette :size="16" /><span>新增花型</span><i v-if="runtime.tasks.some((task) => taskOperation(task) === 'add_pattern' && runningStatuses.has(task.status))" class="taskbar-running" /></button>
      <span class="taskbar-spacer" />
      <div class="taskbar-tray"><span :title="runtime.health.ready ? 'Worker 在线' : 'Worker 离线'"><Wifi :size="15" /></span><span :title="sessionLabel"><ShieldCheck :size="15" /></span><div class="taskbar-clock"><strong>{{ timeLabel }}</strong><small>{{ dateLabel }}</small></div><Clock3 :size="15" /></div>
    </footer>
  </div>
</template>
