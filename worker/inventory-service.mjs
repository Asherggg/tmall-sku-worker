import crypto from "node:crypto";
import { runtimeConfigError, runtimeValue } from "./runtime-config.mjs";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MATERIAL_NO = /^[^\u0000\r\n]{1,1000}$/;
const BARCODE = /^\d{8,20}$/;

export const DEFAULT_INVENTORY_DATABASE = "guanyuan_back";
export const DEFAULT_INVENTORY_TABLE = "ecommerce_sales_inventory_daily_report";
export const FIXED_INVENTORY_API_BASE_URL = "http://10.21.16.213:9031";
export const DEFAULT_INVENTORY_API_PATH = "/v1/materials/lookup";
export const INVENTORY_FIELDS = ["total_material_no", "barcode", "sub_material_name", "specification", "updated_at"];

function text(value) {
  return value == null ? "" : String(value).trim();
}

function safeIdentifier(value, fallback) {
  const candidate = text(value) || fallback;
  if (!IDENTIFIER.test(candidate)) {
    throw Object.assign(new Error(`Doris 标识符无效: ${candidate}`), { code: "inventory_config_invalid" });
  }
  return candidate;
}

export function normalizeMaterialNo(value) {
  const result = text(value);
  return MATERIAL_NO.test(result) ? result : null;
}

export function normalizeBarcode(value) {
  const result = text(value);
  return BARCODE.test(result) ? result : null;
}

export function normalizeInventoryRow(row) {
  const materialNo = normalizeMaterialNo(row?.total_material_no ?? row?.totalMaterialNo ?? row?.materialNo);
  if (!materialNo) return null;
  return {
    total_material_no: materialNo,
    barcode: text(row?.barcode),
    sub_material_name: text(row?.sub_material_name ?? row?.subMaterialName),
    specification: text(row?.specification),
    updated_at: row?.updated_at ?? row?.updatedAt ?? null,
  };
}

function rowFingerprint(row) {
  return JSON.stringify([
    row.total_material_no,
    row.barcode,
    row.sub_material_name,
    row.specification,
  ]);
}

export function groupInventoryRows(rows, requestedMaterialNos = []) {
  const requested = [...new Set(requestedMaterialNos.map(normalizeMaterialNo).filter(Boolean))];
  const groups = new Map(requested.map((materialNo) => [materialNo, []]));
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeInventoryRow(raw);
    if (!row || !groups.has(row.total_material_no)) continue;
    const group = groups.get(row.total_material_no);
    if (!group.some((entry) => rowFingerprint(entry) === rowFingerprint(row))) group.push(row);
  }
  return requested.map((materialNo) => {
    const values = groups.get(materialNo) || [];
    if (!values.length) return { materialNo, status: "missing", rows: [] };
    if (values.length !== 1) return { materialNo, status: "ambiguous", rows: values };
    const row = values[0];
    return {
      materialNo,
      status: row.barcode && row.sub_material_name && row.specification ? "resolved" : "incomplete",
      rows: [row],
    };
  });
}

export function buildInventoryLookupSql({ database = DEFAULT_INVENTORY_DATABASE, table = DEFAULT_INVENTORY_TABLE, materialNos = [] } = {}) {
  const db = safeIdentifier(database, DEFAULT_INVENTORY_DATABASE);
  const tableName = safeIdentifier(table, DEFAULT_INVENTORY_TABLE);
  const values = [...new Set(materialNos.map(normalizeMaterialNo).filter(Boolean))];
  if (!values.length) throw Object.assign(new Error("料号列表不能为空"), { code: "inventory_materials_empty" });
  const escaped = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return `SELECT total_material_no, barcode, sub_material_name, specification, updated_at FROM ${db}.${tableName} WHERE total_material_no IN (${escaped})`;
}

function unwrapRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && normalizeMaterialNo(payload.materialNo ?? payload.total_material_no ?? payload.totalMaterialNo)) return [payload];
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (payload?.data && typeof payload.data === "object" && normalizeMaterialNo(payload.data.materialNo ?? payload.data.total_material_no ?? payload.data.totalMaterialNo)) return [payload.data];
  if (Array.isArray(payload?.data?.records)) return payload.data.records;
  if (Array.isArray(payload?.data?.rows)) return payload.data.rows;
  if (Array.isArray(payload?.data?.result)) return payload.data.result;
  return null;
}

function requestConfig(config = {}) {
  const runtimeError = runtimeConfigError();
  if (runtimeError) throw runtimeError;
  const value = (name) => runtimeValue(name);
  const database = safeIdentifier(config.database || value("DORIS_DATABASE"), DEFAULT_INVENTORY_DATABASE);
  const table = safeIdentifier(config.table || value("DORIS_TABLE"), DEFAULT_INVENTORY_TABLE);
  const usesFixedApi = config.apiBaseUrl === undefined;
  const apiBaseUrl = text(usesFixedApi ? FIXED_INVENTORY_API_BASE_URL : config.apiBaseUrl);
  const apiPath = text(config.apiPath || DEFAULT_INVENTORY_API_PATH);
  const apiToken = text(config.apiToken || value("INVENTORY_API_TOKEN"));
  const apiAuthHeader = text(config.apiAuthHeader || value("INVENTORY_API_AUTH_HEADER") || "Authorization");
  const apiAuthScheme = text(config.apiAuthScheme || value("INVENTORY_API_AUTH_SCHEME") || "Bearer");
  const queryUrl = text(config.queryUrl || value("DORIS_QUERY_URL"));
  const mysqlUrl = text(config.mysqlUrl || value("DORIS_MYSQL_URL"));
  const mysqlHost = text(config.host || value("DORIS_MYSQL_HOST"));
  const mysqlUser = text(config.user || value("DORIS_MYSQL_USER"));
  const mysqlPassword = config.password ?? value("DORIS_MYSQL_PASSWORD") ?? "";
  const mysqlPort = Number(config.port || value("DORIS_MYSQL_PORT") || 9030);
  if (apiBaseUrl) {
    let parsed;
    try { parsed = new URL(apiBaseUrl); } catch (cause) {
      throw Object.assign(new Error("INVENTORY_API_BASE_URL 不是有效 URL"), { code: "inventory_config_invalid", cause });
    }
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const allowInsecureHttp = usesFixedApi || String(config.allowInsecureHttp ?? "false").toLowerCase() === "true";
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:") && !(allowInsecureHttp && parsed.protocol === "http:")) {
      throw Object.assign(new Error("INVENTORY_API_BASE_URL 必须使用 HTTPS；内网 HTTP 仅可通过 INVENTORY_API_ALLOW_INSECURE_HTTP=true 显式开启"), { code: "inventory_config_invalid" });
    }
    if (!apiPath.startsWith("/") || apiPath.includes("?")) {
      throw Object.assign(new Error("INVENTORY_API_PATH 必须是无查询参数的绝对路径"), { code: "inventory_config_invalid" });
    }
    if (!apiToken) throw Object.assign(new Error("INVENTORY_API_TOKEN 未配置"), { code: "inventory_config_missing" });
    return { mode: "remote_api", apiBaseUrl: apiBaseUrl.replace(/\/$/, ""), apiPath, apiToken, apiAuthHeader, apiAuthScheme, allowInsecureHttp, database, table };
  }
  if (queryUrl) {
    let parsed;
    try { parsed = new URL(queryUrl); } catch (cause) {
      throw Object.assign(new Error("DORIS_QUERY_URL 不是有效 URL"), { code: "inventory_config_invalid", cause });
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw Object.assign(new Error("DORIS_QUERY_URL 只允许指向本机查询服务"), { code: "inventory_config_invalid" });
    }
    return { mode: "http", queryUrl, database, table };
  }
  if (mysqlUrl || mysqlHost) {
    if (!mysqlHost && mysqlUrl) {
      try { new URL(mysqlUrl); } catch (cause) {
        throw Object.assign(new Error("DORIS_MYSQL_URL 不是有效 URL"), { code: "inventory_config_invalid", cause });
      }
    }
    if (!Number.isInteger(mysqlPort) || mysqlPort < 1 || mysqlPort > 65535) {
      throw Object.assign(new Error("DORIS_MYSQL_PORT 无效"), { code: "inventory_config_invalid" });
    }
    if (!mysqlUser) throw Object.assign(new Error("DORIS_MYSQL_USER 未配置"), { code: "inventory_config_missing" });
    return { mode: "mysql", mysqlUrl, host: mysqlHost, user: mysqlUser, password: String(mysqlPassword), port: mysqlPort, database, table };
  }
  return { mode: "missing", database, table };
}

export function inventoryHealth(config = {}) {
  try {
    const resolved = requestConfig(config);
    return {
      configured: resolved.mode !== "missing",
      mode: resolved.mode,
      database: resolved.database,
      table: resolved.table,
      queryUrl: resolved.mode === "http" ? resolved.queryUrl : undefined,
      apiUrl: resolved.mode === "remote_api" ? `${resolved.apiBaseUrl}${resolved.apiPath}` : undefined,
    };
  } catch (error) {
    return {
      configured: false,
      mode: error.code === "inventory_config_missing" ? "missing" : "invalid",
      apiUrl: `${FIXED_INVENTORY_API_BASE_URL}${DEFAULT_INVENTORY_API_PATH}`,
      message: error.message,
    };
  }
}

export function createInventoryRepository(config = {}) {
  const resolved = requestConfig(config);
  let poolPromise;
  async function queryMysql(sql, values) {
    if (!poolPromise) {
      poolPromise = import("mysql2/promise").then(({ createPool }) => {
        const options = resolved.mysqlUrl || {
          host: resolved.host,
          port: resolved.port,
          user: resolved.user,
          password: resolved.password,
          database: resolved.database,
        };
        return createPool(options, { waitForConnections: true, connectionLimit: 2, maxIdle: 2, idleTimeout: 60_000, enableKeepAlive: true });
      });
    }
    const pool = await poolPromise;
    const [rows] = await pool.execute(sql, values);
    return rows;
  }
  async function queryHttp(sql, materialNos) {
    const response = await fetch(resolved.queryUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ database: resolved.database, table: resolved.table, materialNos, sql }),
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch (cause) {
      throw Object.assign(new Error("本机商品资料服务返回非 JSON"), { code: "inventory_query_invalid_response", status: response.status, cause });
    }
    if (!response.ok || payload?.success === false || payload?.error) {
      throw Object.assign(new Error(payload?.message || payload?.error || `本机商品资料服务 HTTP ${response.status}`), { code: "inventory_query_failed", status: response.status });
    }
    const rows = unwrapRows(payload);
    if (!rows) throw Object.assign(new Error("本机商品资料服务响应缺少资料记录"), { code: "inventory_query_invalid_response" });
    return rows;
  }
  async function queryRemoteApi(materialNos) {
    const url = `${resolved.apiBaseUrl}${resolved.apiPath}`;
    const headers = { "content-type": "application/json", accept: "application/json" };
    headers[resolved.apiAuthHeader] = resolved.apiAuthScheme ? `${resolved.apiAuthScheme} ${resolved.apiToken}` : resolved.apiToken;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ materialNos }),
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch (cause) {
      throw Object.assign(new Error("商品资料服务返回非 JSON"), { code: "inventory_query_invalid_response", status: response.status, cause });
    }
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error("商品资料服务认证失败"), { code: "inventory_api_auth_required", status: response.status });
    }
    if (!response.ok || payload?.success === false || payload?.error) {
      throw Object.assign(new Error(payload?.message || payload?.error || `商品资料服务 HTTP ${response.status}`), { code: "inventory_query_failed", status: response.status });
    }
    const rows = unwrapRows(payload);
    if (!rows) throw Object.assign(new Error("商品资料服务响应缺少资料记录"), { code: "inventory_query_invalid_response" });
    return rows;
  }
  return {
    config: { ...resolved, password: undefined, apiToken: undefined },
    async lookup(materialNos) {
      const requested = [...new Set((materialNos || []).map(normalizeMaterialNo).filter(Boolean))];
      if (!requested.length) return [];
      const sql = resolved.mode === "remote_api" ? null : buildInventoryLookupSql({ database: resolved.database, table: resolved.table, materialNos: requested });
      const rows = resolved.mode === "remote_api"
        ? await queryRemoteApi(requested)
        : resolved.mode === "http"
          ? await queryHttp(sql, requested)
          : await queryMysql(sql, []);
      return rows.map(normalizeInventoryRow).filter(Boolean);
    },
    async close() {
      if (poolPromise) {
        const pool = await poolPromise.catch(() => null);
        await pool?.end().catch(() => {});
        poolPromise = undefined;
      }
    },
  };
}

export function deriveMaterialNo(row) {
  const candidates = [
    row?.skuOuterId,
    row?.outerId,
    row?.materialNo,
    row?.totalMaterialNo,
    row?.skuMaterialNo,
    row?.skuOldSku,
  ].map(text).filter(Boolean);
  return candidates.find((value) => normalizeMaterialNo(value)) || null;
}

export async function resolveSkuInventory(rows, repository, { requireBarcode = false } = {}) {
  if (!repository || typeof repository.lookup !== "function") {
    throw Object.assign(new Error("Doris 查询服务未配置"), { code: "inventory_query_unconfigured" });
  }
  const sourceRows = Array.isArray(rows) ? rows : [];
  const materialNos = sourceRows.map(deriveMaterialNo);
  const missingMaterialIndex = materialNos.findIndex((value) => !value);
  if (missingMaterialIndex >= 0) {
    throw Object.assign(new Error(`SKU 第 ${missingMaterialIndex + 1} 行缺少可识别料号`), { code: "inventory_material_missing", index: missingMaterialIndex });
  }
  const records = groupInventoryRows(await repository.lookup(materialNos), materialNos);
  const byMaterial = new Map(records.map((entry) => [entry.materialNo, entry]));
  const enriched = sourceRows.map((row, index) => {
    const materialNo = materialNos[index];
    const entry = byMaterial.get(materialNo);
    if (!entry || entry.status === "missing") {
      throw Object.assign(new Error(`Doris 未找到料号 ${materialNo}`), { code: "inventory_material_not_found", materialNo });
    }
    if (entry.status === "ambiguous") {
      throw Object.assign(new Error(`料号 ${materialNo} 对应多条不一致的 Doris 记录`), { code: "inventory_material_ambiguous", materialNo, rows: entry.rows.length });
    }
    const record = entry.rows[0];
    if (!record.sub_material_name || !record.specification) {
      throw Object.assign(new Error(`料号 ${materialNo} 缺少国补品名或规格`), { code: "inventory_metadata_missing", materialNo });
    }
    if (requireBarcode && !normalizeBarcode(record.barcode)) {
      throw Object.assign(new Error(`料号 ${materialNo} 的 69 码为空或格式无效`), { code: "inventory_barcode_missing", materialNo });
    }
    return {
      ...row,
      materialNo,
      barcode: normalizeBarcode(record.barcode),
      subMaterialName: record.sub_material_name,
      specification: record.specification,
      inventoryUpdatedAt: record.updated_at,
    };
  });
  return { rows: enriched, records };
}

export function lookupDigest(records) {
  return crypto.createHash("sha256").update(JSON.stringify(records || [])).digest("hex");
}