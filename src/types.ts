export type Mode = "demo" | "live";

export type TaskStatus =
  | "draft"
  | "validated"
  | "planned"
  | "awaiting_confirmation"
  | "queued"
  | "reading_snapshot"
  | "temp_submitting"
  | "temp_verified"
  | "restoring"
  | "final_verifying"
  | "succeeded"
  | "paused"
  | "needs_manual_review"
  | "failed";

export interface ItemInput {
  itemId: string;
  skuIds: string[];
  expectedSkuCount?: number;
}

export interface TaskRecord {
  id: string;
  batchId: string;
  itemId: string;
  skuIds: string[];
  expectedSkuCount?: number;
  mode: Mode;
  status: TaskStatus;
  phaseLabel: string;
  progress: number;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  oldSkuIds?: string[];
  newSkuIds?: string[];
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEntry[];
}

export interface TimelineEntry {
  at: string;
  phase: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
}

export interface BatchRecord {
  id: string;
  mode: Mode;
  confirmation: boolean;
  itemCount: number;
  skuCount: number;
  status: "draft" | "queued" | "running" | "succeeded" | "partial" | "failed";
  createdAt: string;
  taskIds: string[];
}

export interface WorkerHealth {
  ready: boolean;
  mode: "demo" | "live";
  workerVersion: string;
  browser: "hidden" | "visible" | "stopped" | "unavailable";
  profile: string;
  loggedIn: boolean;
  riskRequired?: boolean;
  contract: "demo" | "configured" | "missing";
  message?: string;
  currentUrl?: string;
  webdriver?: boolean | null;
}

export interface AuditRecord {
  id: string;
  taskId: string;
  itemId: string;
  phase: string;
  method: string;
  path: string;
  status?: number;
  businessCode?: string;
  requestId: string;
  at: string;
}

export interface ImportPreview {
  items: ItemInput[];
  valid: boolean;
  errors: string[];
  skuCount: number;
}
