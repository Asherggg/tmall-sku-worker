import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fillSubsidyWorkbookFile, normalizeSkuMappings } from "./subsidy-workbook.mjs";

export const SUBSIDY_MTOP_ORIGIN = "https://h5api.m.taobao.com";
export const SUBSIDY_FILE_OPERATOR_API = "mtop.tmall.industry.ofn.gov.workbench.file.common.operator";
export const SUBSIDY_FILE_CONFIG_API = "mtop.tmall.industry.ofn.gov.workbench.query.file.config";
export const SUBSIDY_ITEM_QUERY_API = "mtop.tmall.industry.ofn.gov.item.query.v2";
const MTOP_APP_KEY = "12574478";
const MTOP_TTID = "11320@taobao_WEB_9.9.99";
const SUBSIDY_OSS_HOSTS = new Set(["crpfile.oss-cn-zhangjiakou.aliyuncs.com"]);
const EXPORT_TIMEOUT_MS = 120_000;
const READBACK_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;
let callbackSequence = 0;

function text(value) {
  return value == null ? "" : String(value).trim();
}

function error(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function requestContext(page) {
  const context = page?.context?.();
  if (!context?.request?.fetch || typeof context.cookies !== "function") {
    throw error("浏览器登录态接口不可用", "subsidy_browser_context_unavailable");
  }
  return context;
}

function parseJsonp(body) {
  const raw = String(body || "").trim();
  const match = raw.match(/^\s*[A-Za-z_$][\w$]*\(([^]*)\)\s*;?\s*$/);
  try {
    return JSON.parse(match ? match[1] : raw);
  } catch (cause) {
    throw error("国补 MTop 响应不是有效 JSON/JSONP", "subsidy_api_invalid_json", { cause });
  }
}

function resultData(payload) {
  return payload?.data?.resultData ?? payload?.data ?? {};
}

function responseError(payload) {
  const ret = Array.isArray(payload?.ret) ? payload.ret : [];
  if (!ret.length) return "MTop 响应缺少业务状态";
  const failure = ret.find((entry) => !/^SUCCESS::/i.test(String(entry)));
  return failure ? String(failure) : null;
}

function tokenExpired(message) {
  return /TOKEN_EXOIRED|TOKEN_EXPIRED|TOKEN_INVALID|令牌|token/i.test(String(message || ""));
}

async function mtopToken(context) {
  const cookies = await context.cookies([SUBSIDY_MTOP_ORIGIN, "https://myseller.taobao.com"]);
  const cookie = cookies.find((entry) => entry.name === "_m_h5_tk");
  const token = text(cookie?.value).split("_")[0];
  if (!token) throw error("国补登录态缺少 MTop 会话令牌，请先检查国补登录", "subsidy_auth_required");
  return token;
}

function mtopRequest(api, data, token, method) {
  const dataText = JSON.stringify(data);
  const timestamp = String(Date.now());
  const sign = crypto.createHash("md5").update(`${token}&${timestamp}&${MTOP_APP_KEY}&${dataText}`).digest("hex");
  const url = new URL(`${SUBSIDY_MTOP_ORIGIN}/h5/${api}/1.0/`);
  const isPost = method === "POST";
  const params = {
    jsv: "2.6.1",
    appKey: MTOP_APP_KEY,
    t: timestamp,
    sign,
    api,
    v: "1.0",
    ttid: MTOP_TTID,
    dataType: isPost ? "json" : "originaljsonp",
    type: isPost ? "originaljson" : "originaljsonp",
  };
  if (!isPost) {
    params.callback = `mtopjsonp${String(++callbackSequence).padStart(3, "0")}`;
    params.data = dataText;
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url, dataText };
}

export async function callSubsidyMtop(page, api, data, { retryToken = true, method = "GET", phase = "subsidy_api", onNetwork } = {}) {
  const context = requestContext(page);
  let lastFailure = null;
  for (let attempt = 0; attempt < (retryToken ? 2 : 1); attempt += 1) {
    const token = await mtopToken(context);
    const { url, dataText } = mtopRequest(api, data, token, method);
    const requestInit = {
      method,
      headers: {
        Accept: "application/javascript, application/json",
        Origin: "https://myseller.taobao.com",
        Referer: "https://myseller.taobao.com/home.htm/gov-subsidy/goods-manage",
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(method === "POST" ? { data: new URLSearchParams({ data: dataText }).toString() } : {}),
      failOnStatusCode: false,
      timeout: 30_000,
    };
    let response;
    try {
      response = await context.request.fetch(url.toString(), requestInit);
    } catch {
      throw error("国补 MTop 网络请求失败", "subsidy_api_network_error", { api });
    }
    const body = await response.text();
    let payload;
    try { payload = parseJsonp(body); } catch (cause) {
      throw Object.assign(cause, { status: response.status(), api });
    }
    const failure = responseError(payload);
    const businessFailure = payload?.success === false || payload?.data?.success === false;
    const businessMessage = text(payload?.data?.message || payload?.data?.errorMessage);
    await onNetwork?.({ phase, api, method, status: response.status(), path: `/h5/${api}/1.0/`, businessCode: failure || (businessFailure ? "BUSINESS_FAILURE" : "SUCCESS") });
    if (response.status() >= 200 && response.status() < 300 && !failure && !businessFailure) {
      return { status: response.status(), payload, traceId: payload?.traceId || null, api, method };
    }
    const message = failure || businessMessage || `国补 MTop HTTP ${response.status()}`;
    lastFailure = error(message, tokenExpired(message) ? "subsidy_auth_required" : "subsidy_api_error", { status: response.status(), api });
    if (!retryToken || !tokenExpired(message) || attempt > 0) throw lastFailure;
  }
  throw lastFailure || error("国补 MTop 请求失败", "subsidy_api_error");
}

function assertMtopSuccess(result, operation) {
  if (!result?.payload) throw error(`${operation} 未返回有效响应`, "subsidy_api_invalid_response");
  return resultData(result.payload);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function allowedOssHostname(hostname) {
  return SUBSIDY_OSS_HOSTS.has(text(hostname).toLowerCase());
}

function safeDownloadUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch (cause) { throw error("国补模板下载地址无效", "subsidy_download_url_invalid", { cause }); }
  if (parsed.protocol !== "https:" || !allowedOssHostname(parsed.hostname)) {
    throw error("国补模板下载地址不在允许范围内", "subsidy_download_url_invalid");
  }
  return parsed.toString();
}

export async function downloadSubsidyTemplateApi(page, itemId, outputPath, { timeoutMs = EXPORT_TIMEOUT_MS, onNetwork } = {}) {
  const context = requestContext(page);
  const exportResult = await callSubsidyMtop(page, SUBSIDY_FILE_OPERATOR_API, {
    taskType: "SUBSIDY_GOODS_POOL_DOWNLOAD",
    bizType: "SUBSIDY_GOODS_POOL_DOWNLOAD",
    action: "EXPORT",
    query: JSON.stringify({ itemIds: [String(itemId)] }),
  }, { phase: "subsidy_template_export", onNetwork });
  const exportData = assertMtopSuccess(exportResult, "国补模板导出");
  const taskId = text(exportData?.resultData?.taskId || exportData?.taskId || exportData?.resultData?.importTaskId);
  if (!taskId) throw error("国补模板导出未返回任务 ID", "subsidy_export_task_missing");
  const deadline = Date.now() + timeoutMs;
  let progressData = null;
  while (Date.now() <= deadline) {
    const progressResult = await callSubsidyMtop(page, SUBSIDY_FILE_OPERATOR_API, {
      taskType: "SUBSIDY_GOODS_POOL_DOWNLOAD",
      bizType: "SUBSIDY_GOODS_POOL_DOWNLOAD",
      action: "QUERY_PROGRESS",
      importTaskId: taskId,
    }, { phase: "subsidy_template_export_progress", onNetwork });
    progressData = assertMtopSuccess(progressResult, "国补模板导出进度");
    const status = String(progressData?.resultData?.taskStatus || progressData?.taskStatus || "").toUpperCase();
    if (status === "FINISHED" || status === "SUCCESS" || progressData?.resultData?.url || progressData?.url) break;
    if (["FAILED", "FAIL", "ERROR"].includes(status)) throw error("国补模板导出失败", "subsidy_export_failed", { taskId, taskStatus: status });
    await sleep(POLL_INTERVAL_MS);
  }
  const rawDownloadUrl = progressData?.resultData?.url || progressData?.url;
  if (!rawDownloadUrl) {
    throw error("国补模板导出超时", "subsidy_export_timeout", { taskId, timeoutMs });
  }
  const downloadUrl = safeDownloadUrl(rawDownloadUrl);
  let response;
  try {
    response = await context.request.fetch(downloadUrl, {
      method: "GET",
      headers: { Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Referer: "https://myseller.taobao.com/home.htm/gov-subsidy/goods-manage" },
      failOnStatusCode: false,
      timeout: 60_000,
    });
  } catch {
    throw error("国补模板下载请求失败", "subsidy_download_failed");
  }
  if (response.status() < 200 || response.status() >= 300) throw error(`国补模板下载 HTTP ${response.status()}`, "subsidy_download_failed", { status: response.status() });
  await fs.writeFile(outputPath, await response.body());
  await onNetwork?.({ phase: "subsidy_template_download", method: "GET", path: "/gei/<task>.xlsx", status: response.status(), api: "oss", businessCode: "SUCCESS" });
  return { taskId, progress: progressData, outputPath };
}

function uploadUrlFromConfig(config) {
  const source = config?.tempUrl || config?.url;
  let parsed;
  try {
    parsed = source
      ? new URL(String(source))
      : new URL(/^https?:\/\//i.test(text(config?.host || config?.domain)) ? text(config?.host || config?.domain) : `https://${text(config?.host || config?.domain)}`);
  } catch (cause) {
    throw error("国补上传配置缺少有效 OSS 地址", "subsidy_upload_config_invalid", { cause });
  }
  if (!allowedOssHostname(parsed.hostname)) throw error("国补上传地址不在允许范围内", "subsidy_upload_config_invalid");
  return `https://${parsed.host}`;
}

export async function uploadSubsidyFileApi(page, filePath, fileName, { onNetwork } = {}) {
  const context = requestContext(page);
  const configResult = await callSubsidyMtop(page, SUBSIDY_FILE_CONFIG_API, {
    bizType: "SUBSIDY_GOODS_POOL_FILE",
    fileName,
  }, { phase: "subsidy_upload_config", onNetwork });
  const config = assertMtopSuccess(configResult, "国补文件上传配置");
  if (!config?.key || !config.policy || !config.signature || !config.accessKeyId) {
    throw error("国补上传配置字段不完整", "subsidy_upload_config_invalid");
  }
  const buffer = await fs.readFile(filePath);
  const uploadUrl = uploadUrlFromConfig(config);
  let uploadResponse;
  try {
    uploadResponse = await context.request.fetch(uploadUrl, {
      method: "POST",
      multipart: {
        key: config.key,
        policy: config.policy,
        OSSAccessKeyId: config.accessKeyId,
        success_action_status: "200",
        Signature: config.signature,
        file: { name: fileName, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer },
      },
      failOnStatusCode: false,
      timeout: 60_000,
    });
  } catch {
    throw error("国补文件上传请求失败", "subsidy_upload_failed");
  }
  if (uploadResponse.status() < 200 || uploadResponse.status() >= 300) {
    throw error(`国补文件上传 HTTP ${uploadResponse.status()}`, "subsidy_upload_failed", { status: uploadResponse.status() });
  }
  await onNetwork?.({ phase: "subsidy_file_upload", method: "POST", path: "/SUBSIDY_GOODS_POOL_FILE/<file>.xlsx", status: uploadResponse.status(), api: "oss", businessCode: "SUCCESS" });
  return { key: config.key, fileName, status: uploadResponse.status() };
}

export async function importSubsidyFileApi(page, fileInfo, { onNetwork } = {}) {
  const result = await callSubsidyMtop(page, SUBSIDY_FILE_OPERATOR_API, {
    taskType: "SUBSIDY_GOODS_POOL_UPLOAD",
    bizType: "SUBSIDY_GOODS_POOL_UPLOAD",
    key: fileInfo.key,
    fileName: fileInfo.fileName,
    action: "IMPORT",
  }, { retryToken: false, method: "POST", phase: "subsidy_submit", onNetwork });
  const data = assertMtopSuccess(result, "国补文件提交");
  return { ...result, resultData: data?.resultData || data };
}

export async function querySubsidyItemsApi(page, itemId, { pageSize = 100, onNetwork } = {}) {
  const rows = [];
  const seenPages = new Set();
  for (let pageNo = 1; pageNo <= 20; pageNo += 1) {
    const result = await callSubsidyMtop(page, SUBSIDY_ITEM_QUERY_API, {
      pageNo,
      pageSize,
      itemIdList: JSON.stringify([String(itemId)]),
      itemCategoryIds: "[]",
    }, { phase: "subsidy_readback", onNetwork });
    const data = assertMtopSuccess(result, "国补商品回读");
    const pageRows = Array.isArray(data) ? data : Array.isArray(data?.resultData) ? data.resultData : Array.isArray(data?.list) ? data.list : [];
    if (!pageRows.length) break;
    const pageIdentity = pageRows.map((row) => `${text(row?.itemId)}:${text(row?.skuId)}`).join("|");
    if (seenPages.has(pageIdentity)) break;
    seenPages.add(pageIdentity);
    rows.push(...pageRows.filter((row) => String(row?.itemId ?? "") === String(itemId)));
  }
  if (!rows.length) throw error(`国补列表未找到商品 ${itemId}`, "subsidy_readback_item_missing");
  return rows;
}

function readbackMatches(row, mapping) {
  const same = (actual, expected) => !expected || text(actual) === text(expected);
  return same(row?.barcode, mapping.barcode)
    && same(row?.zfbtModel, mapping.subMaterialName)
    && same(row?.modelDesc, mapping.specification);
}

export async function waitForSubsidyReadbackApi(page, itemId, mappings, { timeoutMs = READBACK_TIMEOUT_MS, onNetwork, onReadback } = {}) {
  const normalized = normalizeSkuMappings(mappings);
  const expected = new Map(normalized.map((mapping) => [mapping.newSkuId, mapping]));
  const deadline = Date.now() + timeoutMs;
  let lastRows = [];
  let attempts = 0;
  let lastError = null;
  while (true) {
    attempts += 1;
    try {
      lastRows = await querySubsidyItemsApi(page, itemId, { onNetwork });
      lastError = null;
    } catch (cause) {
      if (cause?.code !== "subsidy_readback_item_missing") throw cause;
      lastRows = [];
      lastError = cause;
    }
    const matched = lastRows.filter((row) => expected.has(String(row?.skuId ?? "")));
    const complete = matched.length === expected.size
      && new Set(matched.map((row) => String(row?.skuId ?? ""))).size === expected.size
      && matched.every((row) => readbackMatches(row, expected.get(String(row.skuId))));
    if (complete) {
      await onReadback?.({ phase: "subsidy_readback", method: "GET", path: `/h5/${SUBSIDY_ITEM_QUERY_API}/1.0/`, status: 200, rowCount: matched.length, attempts });
      return { verified: true, rows: matched, attempts };
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  throw error("国补提交后回读未达到预期 SKU、69 码、品名和规格", "subsidy_readback_mismatch", { itemId: String(itemId), rows: lastRows, attempts, cause: lastError || undefined });
}

export async function executeTmallSubsidyApi(page, task, skuMappings, hooks = {}, options = {}) {
  if (!page || page.isClosed?.()) throw error("国补页面不可用", "subsidy_page_unavailable");
  const normalized = normalizeSkuMappings(skuMappings);
  const missingBarcode = normalized.find((mapping) => !mapping.barcode);
  if (missingBarcode) throw error(`SKU ${missingBarcode.newSkuId} 缺少国补回读所需的 69 码`, "subsidy_mapping_barcode_missing", { skuId: missingBarcode.newSkuId });
  const dataDir = options.dataDir || process.env.TMALL_DATA_DIR || ".runtime/tmall-worker";
  const templateDir = path.join(dataDir, "subsidy");
  await fs.mkdir(templateDir, { recursive: true });
  const inputPath = path.join(templateDir, `${task.id}-template.xlsx`);
  const outputPath = path.join(templateDir, `${task.id}-filled.xlsx`);
  await hooks.onPhase?.({ phase: "subsidy_preparing", progress: 88, level: "info", message: "通过已登录 Edge 会话请求国补模板" });
  await downloadSubsidyTemplateApi(page, task.itemId, inputPath, { ...options, onNetwork: hooks.onNetwork });
  const filled = await fillSubsidyWorkbookFile(inputPath, outputPath, normalized);
  const fileInfo = await uploadSubsidyFileApi(page, outputPath, path.basename(outputPath), { onNetwork: hooks.onNetwork });
  await hooks.onPhase?.({ phase: "subsidy_template_ready", progress: 92, level: "info", message: `国补模板已填充 ${filled.matchedRows} 行并通过接口上传` });
  if (options.dryRun === true) {
    return {
      itemId: String(task.itemId),
      transport: "api",
      dryRun: true,
      inputPath,
      outputPath,
      matchedRows: filled.matchedRows,
      workbookSha256: filled.sha256,
      uploadStatus: fileInfo.status,
    };
  }
  await hooks.onWriteStart?.({ phase: "subsidy_submit", itemId: String(task.itemId) });
  const imported = await importSubsidyFileApi(page, fileInfo, { onNetwork: hooks.onNetwork });
  const readback = await waitForSubsidyReadbackApi(page, task.itemId, normalized, {
    ...options,
    onNetwork: hooks.onNetwork,
    onReadback: hooks.onReadback,
  });
  await hooks.onPhase?.({ phase: "subsidy_verified", progress: 100, level: "success", message: "国补接口提交成功并完成列表回读" });
  return {
    itemId: String(task.itemId),
    transport: "api",
    inputPath,
    outputPath,
    matchedRows: filled.matchedRows,
    workbookSha256: filled.sha256,
    importTraceId: imported.traceId,
    readback: { verified: readback.verified, rowCount: readback.rows.length },
  };
}
