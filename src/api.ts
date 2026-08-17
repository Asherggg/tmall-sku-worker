import type { BatchRecord, ItemInput, TaskRecord, WorkerHealth } from "./types";
import { parseImport } from "./import-parser";

export { parseImport };

const BASE = import.meta.env.VITE_WORKER_URL || "http://127.0.0.1:19828";

const demoHealth: WorkerHealth = {
  ready: false,
  mode: "demo",
  workerVersion: "0.1.10",
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

export async function getTasks(): Promise<TaskRecord[]> {
  try {
    const payload = await request<{ tasks: TaskRecord[] }>("/tasks");
    return payload.tasks;
  } catch {
    return [];
  }
}

export async function getBatches(): Promise<BatchRecord[]> {
  try {
    const payload = await request<{ batches: BatchRecord[] }>("/batches");
    return payload.batches;
  } catch {
    return [];
  }
}

export async function exportAudit() {
  return request<{ exportedAt: string; records: unknown[] }>("/audit/export");
}

export async function createBatch(items: ItemInput[], mode: "demo" | "live", confirmation: string) {
  return request<{ batchId: string; tasks: TaskRecord[] }>("/tasks", { method: "POST", body: JSON.stringify({ items, mode, confirmation }) });
}

export async function startBatch(batchId: string, confirmation: string) {
  return request<{ accepted: boolean }>(`/batches/${encodeURIComponent(batchId)}/start`, { method: "POST", body: JSON.stringify({ confirmation }) });
}

export async function pauseTask(taskId: string) {
  return request<{ accepted: boolean }>(`/tasks/${encodeURIComponent(taskId)}/pause`, { method: "POST" });
}

export async function retryTask(taskId: string) {
  return request<{ accepted: boolean }>(`/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
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
