export type Mode = "demo" | "live";
export type TaskOperation = "sku_rebuild" | "add_pattern";
export type ChannelOption = "1" | "2";

export const CHANNEL_OPTION_LABELS: Record<ChannelOption, string> = {
  "1": "纯电商",
  "2": "商场同款",
};

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
  | "pattern_preparing"
  | "pattern_submitting"
  | "pattern_verifying"
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

export interface PatternSkuInput {
  sourceRow: number;
  specification: string;
  color: string;
  price: string;
  quantity: number;
  merchantCode: string;
  barcode: string;
  remark: string;
}

export interface AddPatternItemInput {
  itemId: string;
  rows: PatternSkuInput[];
}

export interface PatternImportRow extends PatternSkuInput {
  itemId: string;
}

export interface PatternImportPreview {
  items: AddPatternItemInput[];
  rows: PatternImportRow[];
  valid: boolean;
  canSubmit: boolean;
  errors: string[];
  warnings: string[];
  sheetName: string;
  requestedCount: number;
}

export interface TaskRecord {
  id: string;
  batchId: string;
  operation?: TaskOperation;
  itemId: string;
  skuIds: string[];
  expectedSkuCount?: number;
  patternRows?: PatternSkuInput[];
  addedSkuIds?: string[];
  existingSkuIds?: string[];
  existingCount?: number;
  additionCount?: number;
  patternPropertyKeys?: { specificationKey: string; colorKey: string };
  mode: Mode;
  status: TaskStatus;
  phaseLabel: string;
  progress: number;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  channelOption?: ChannelOption;
  channelOptionObserved?: string;
  channelOptionSource?: string;
  channelMigrationRequired?: boolean;
  liveWriteStarted?: boolean;
  writePhase?: string;
  detailVariant?: Record<string, unknown>;
  recoverySnapshot?: Record<string, unknown>;
  snapshotBefore?: Record<string, unknown>;
  snapshotAfter?: Record<string, unknown>;
  fieldComparison?: Record<string, unknown>;
  skuMappings?: SkuMapping[];
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
  operation?: TaskOperation;
  mode: Mode;
  confirmation: boolean;
  itemCount: number;
  skuCount: number;
  status: "draft" | "queued" | "running" | "succeeded" | "partial" | "failed";
  createdAt: string;
  taskIds: string[];
}

export interface SkuMapping {
  oldSkuId: string;
  newSkuId: string;
}

export interface WorkflowHealth {
  configured: boolean;
  missing: Array<"sku_rebuild" | "add_pattern">;
}

export interface WorkerHealth {
  ready: boolean;
  mode: "demo" | "live";
  workerVersion: string;
  browser: "hidden" | "visible" | "stopped" | "unavailable";
  profile: string;
  loggedIn: boolean;
  workflow?: WorkflowHealth;
  riskRequired?: boolean;
  contract: "demo" | "configured" | "missing";
  message?: string;
  currentUrl?: string;
  webdriver?: boolean | null;
  unresolvedLiveWrites?: number;
  liveBatchConcurrency?: number;
}

export interface AuditRecord {
  id: string;
  taskId: string;
  itemId: string;
  phase: string;
  method: string;
  path: string;
  status?: number;
  durationMs?: number;
  elapsedMs?: number;
  attempts?: number;
  deadlineMs?: number;
  deadlineReadback?: boolean;
  strategy?: string;
  transport?: string;
  polling?: string;
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
