import type { AddPatternItemInput, BatchRecord, ChannelOption, ItemInput, TaskOperation, TaskRecord, WorkerHealth } from "./types";
import { parseImport } from "./import-parser";

export { parseImport };

const BASE = import.meta.env.VITE_WORKER_URL || "http://127.0.0.1:19828";

const demoHealth: WorkerHealth = {
  ready: false,
  mode: "demo",
  workerVersion: "0.1.30",
  browser: "unavailable",
  profile: "应用专属 Profile",
  loggedIn: false,
  contract: "demo",
  message: "Worker 尚未启动，请重新打开程序或检查后台进程",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Worker request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function getHealth(): Promise<WorkerHealth> {
  try {
    return await request<WorkerHealth>("/health");
  } catch {
    return demoHealth;
  }
}

export async function getTasks(operation?: TaskOperation): Promise<TaskRecord[]> {
  try {
    const query = operation ? `?operation=${encodeURIComponent(operation)}` : "";
    const payload = await request<{ tasks: TaskRecord[] }>(`/tasks${query}`);
    return payload.tasks;
  } catch {
    return [];
  }
}

export async function getBatches(operation?: TaskOperation): Promise<BatchRecord[]> {
  try {
    const query = operation ? `?operation=${encodeURIComponent(operation)}` : "";
    const payload = await request<{ batches: BatchRecord[] }>(`/batches${query}`);
    return payload.batches;
  } catch {
    return [];
  }
}

export async function exportAudit() {
  return request<{ exportedAt: string; records: unknown[] }>("/audit/export");
}

export async function createBatch(items: ItemInput[], mode: "demo" | "live", confirmation: string) {
  return request<{ batchId: string; tasks: TaskRecord[] }>("/tasks", { method: "POST", body: JSON.stringify({ operation: "sku_rebuild", items, mode, confirmation }) });
}

export async function createAddPatternBatch(items: AddPatternItemInput[], mode: "demo" | "live", confirmation: string) {
  return request<{ batchId: string; tasks: TaskRecord[] }>("/tasks", {
    method: "POST",
    body: JSON.stringify({ operation: "add_pattern", items, mode, confirmation }),
  });
}

export async function startBatch(batchId: string, confirmation: string) {
  return request<{ accepted: boolean }>(`/batches/${encodeURIComponent(batchId)}/start`, { method: "POST", body: JSON.stringify({ confirmation }) });
}

export async function pauseTask(taskId: string) {
  return request<{ accepted: boolean }>(`/tasks/${encodeURIComponent(taskId)}/pause`, { method: "POST" });
}

export async function retryTask(taskId: string, channelOption?: ChannelOption, confirmChannelMigration = false) {
  return request<{ accepted: boolean; channelOption?: ChannelOption }>(`/tasks/${encodeURIComponent(taskId)}/retry`, {
    method: "POST",
    body: JSON.stringify({
      ...(channelOption ? { channelOption } : {}),
      ...(confirmChannelMigration ? { confirmChannelMigration: true } : {}),
    }),
  });
}

export async function deleteTask(taskId: string, confirmation?: string) {
  return request<{ deleted: boolean; taskId: string; batchId: string; removedBatch: boolean; manuallyResolved: boolean }>(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation }),
  });
}

export async function browserAction(action: "login" | "hide" | "verify") {
  return request<WorkerHealth>(`/browser/${action}`, { method: "POST" });
}
