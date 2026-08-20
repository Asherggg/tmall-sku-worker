const OMS_PAGE_URL = "https://oms.shuixing.com/#/platformCommodity";
const OMS_ORIGIN = "https://gateway.shuixing.com";
const OMS_BASE_PATH = "/oms-system";
const QUERY_PATH = "/base/platformGoods/queryPage";
const TOGGLE_ENABLED_PATH = "/base/platformGoods/enable";
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 20;

function text(value) {
  return value == null ? "" : String(value).trim();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function positiveId(value) {
  const result = text(value);
  return /^\d+$/.test(result) && Number(result) > 0 ? result : null;
}

function parseJson(textValue) {
  try { return JSON.parse(textValue || "{}"); } catch { return null; }
}

function messageFrom(payload) {
  return text(payload?.msg || payload?.message || payload?.error || payload?.data?.msg);
}

function isLoginResponse(status, url, bodyText) {
  return status === 401 || status === 403 || /login|cas|passport|统一认证/i.test(`${url} ${bodyText.slice(0, 2000)}`);
}

export function buildOmsQueryBody(itemId, pageNum = 1, pageSize = MAX_PAGE_SIZE, enabledOnly = false) {
  const normalized = positiveId(itemId);
  if (!normalized) throw Object.assign(new Error("OMS 商品 ID 必须是正整数"), { code: "oms_item_id_invalid" });
  const body = { baseImc09: normalized, pageNum, pageSize };
  if (enabledOnly) {
    body.baseImc39 = "1";
    body.baseImc15 = "onsale";
  }
  return body;
}

export function classifyOmsResponse(status, responseUrl, bodyText) {
  const payload = parseJson(bodyText);
  if (isLoginResponse(status, responseUrl, bodyText)) {
    return { ok: false, code: "oms_auth_required", businessCode: `HTTP_${status}`, message: "OMS 登录态失效或需要重新认证", payload };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, code: "oms_http_error", businessCode: `HTTP_${status}`, message: messageFrom(payload) || `OMS 接口 HTTP ${status}`, payload };
  }
  if (!payload) {
    return { ok: false, code: "oms_response_invalid", businessCode: "INVALID_JSON", message: "OMS 接口返回非 JSON", payload: null };
  }
  const code = payload.code ?? payload.status;
  if (String(code) === "401") {
    return { ok: false, code: "oms_auth_required", businessCode: "401", message: messageFrom(payload) || "OMS 登录态失效或需要重新认证", payload };
  }
  if (code != null && String(code) !== "200" && code !== 200) {
    return { ok: false, code: "oms_business_error", businessCode: String(code), message: messageFrom(payload) || "OMS 接口返回业务错误", payload };
  }
  return { ok: true, code: "SUCCESS", businessCode: String(code ?? "200"), message: messageFrom(payload) || "OMS 接口成功", payload };
}

function responseRecords(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.list)) return payload.list;
  return null;
}

function recordItemId(record) {
  return positiveId(record?.baseImc09 ?? record?.platformItemId ?? record?.itemId ?? record?.numIid ?? record?.auctionId);
}

function recordId(record) {
  return positiveId(record?.id ?? record?.baseImc00 ?? record?.platformGoodsId);
}

function enabledValue(record) {
  const value = record?.baseImc39 ?? record?.enabled ?? record?.enable ?? record?.isEnabled;
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["1", "true", "启用", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "禁用", "off", "disabled"].includes(normalized)) return false;
  return null;
}

export function normalizeOmsRecord(record, expectedItemId) {
  const itemId = recordItemId(record);
  const id = recordId(record);
  return {
    id,
    itemId,
    enabled: enabledValue(record),
    shopCode: text(record?.baseImc01 ?? record?.shopCode),
    skuId: positiveId(record?.baseImc13 ?? record?.skuId ?? record?.platformSkuId),
    materialNo: text(record?.baseImc21 ?? record?.materialNo),
    raw: clone(record),
    matchesItem: itemId === text(expectedItemId),
  };
}

export function extractPlatformGoodsRecords(payload, expectedItemId) {
  const rows = responseRecords(payload);
  if (!rows) throw Object.assign(new Error("OMS 查询响应缺少商品记录列表"), { code: "oms_response_shape_invalid" });
  return rows.map((record) => normalizeOmsRecord(record, expectedItemId));
}

function requestContext(page) {
  const context = page?.context?.();
  if (!context?.request?.fetch) throw Object.assign(new Error("浏览器登录态接口不可用"), { code: "browser_api_context_unavailable" });
  return context;
}

async function readOmsToken(page) {
  let token = "";
  try {
    const state = await page.context().storageState();
    const origin = state.origins?.find((entry) => entry.origin === "https://oms.shuixing.com");
    token = origin?.localStorage?.find((entry) => entry.name === "token")?.value || "";
  } catch {}
  if (!token || typeof token !== "string" || token.length > 8192) {
    throw Object.assign(new Error("OMS 登录 token 不可用，请重新登录"), { code: "oms_auth_required" });
  }
  return token;
}

function allowedOmsUrl(url) {
  const parsed = new URL(url);
  return parsed.origin === OMS_ORIGIN && parsed.pathname.startsWith(`${OMS_BASE_PATH}/`)
    && new Set([`${OMS_BASE_PATH}${QUERY_PATH}`, `${OMS_BASE_PATH}${TOGGLE_ENABLED_PATH}`]).has(parsed.pathname);
}

async function apiFetch(page, path, { body: requestBody, timeout = 30_000 } = {}) {
  const url = `${OMS_ORIGIN}${OMS_BASE_PATH}${path}`;
  if (!allowedOmsUrl(url)) throw Object.assign(new Error("OMS 请求地址不在白名单"), { code: "oms_endpoint_not_allowed" });
  const context = requestContext(page);
  const token = await readOmsToken(page);
  const response = await context.request.fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Cas-Auth-Token": token,
      Referer: OMS_PAGE_URL,
    },
    data: JSON.stringify(requestBody),
    timeout,
    failOnStatusCode: false,
  });
  return { status: response.status(), text: await response.text(), url: response.url() };
}

async function report(hooks, name, payload) {
  if (typeof hooks?.[name] === "function") await hooks[name](payload);
}

async function queryPage(page, itemId, hooks, enabledOnly = false) {
  const all = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    const requestBody = buildOmsQueryBody(itemId, pageNum, MAX_PAGE_SIZE, enabledOnly);
    const result = await apiFetch(page, QUERY_PATH, { body: requestBody });
    const classification = classifyOmsResponse(result.status, result.url, result.text);
    await report(hooks, "onNetwork", { phase: "oms_query", method: "POST", path: QUERY_PATH, status: result.status, classification });
    if (!classification.ok) throw Object.assign(new Error(classification.message), { code: classification.code, businessCode: classification.businessCode, status: result.status });
    const records = extractPlatformGoodsRecords(classification.payload, itemId);
    all.push(...records);
    const total = Number(classification.payload?.data?.total ?? classification.payload?.total ?? records.length);
    if (records.length < MAX_PAGE_SIZE || all.length >= total) break;
  }
  return all;
}

export async function executeOmsDisable(page, itemId, hooks = {}) {
  const normalizedItemId = positiveId(itemId);
  if (!normalizedItemId) throw Object.assign(new Error("OMS 商品 ID 无效"), { code: "oms_item_id_invalid" });
  await report(hooks, "onPhase", { phase: "oms_preparing", progress: 6, level: "info", message: `正在 OMS 查询商品 ${normalizedItemId}` });
  let records = await queryPage(page, normalizedItemId, hooks, false);
  if (!records.length) records = await queryPage(page, normalizedItemId, hooks, true);
  const matching = records.filter((record) => record.matchesItem);
  if (!matching.length) throw Object.assign(new Error(`OMS 未找到商品 ${normalizedItemId} 的平台商品记录`), { code: "oms_goods_not_found", itemId: normalizedItemId });
  if (matching.some((record) => !record.id)) throw Object.assign(new Error("OMS 商品记录缺少可用记录 ID"), { code: "oms_record_id_missing", itemId: normalizedItemId });
  if (matching.some((record) => record.enabled == null)) throw Object.assign(new Error("OMS 商品记录缺少可识别的启用状态"), { code: "oms_enabled_state_missing", itemId: normalizedItemId });
  const targetRecords = matching.filter((record) => record.enabled === true);
  await report(hooks, "onPhase", { phase: "oms_snapshot", progress: 10, level: "info", message: `OMS 已找到 ${matching.length} 条记录，${targetRecords.length} 条仍为启用状态` });
  if (targetRecords.length) {
    const ids = [...new Set(targetRecords.map((record) => record.id))];
    await report(hooks, "onWriteStart", { phase: "oms_disable", itemId: normalizedItemId, recordCount: ids.length });
    const result = await apiFetch(page, TOGGLE_ENABLED_PATH, { body: { idList: ids }, timeout: 30_000 });
    const classification = classifyOmsResponse(result.status, result.url, result.text);
    await report(hooks, "onNetwork", { phase: "oms_disable", method: "POST", path: TOGGLE_ENABLED_PATH, status: result.status, classification });
    if (!classification.ok) throw Object.assign(new Error(classification.message), { code: classification.code, businessCode: classification.businessCode, status: result.status });
    await report(hooks, "onPhase", { phase: "oms_disabled", progress: 16, level: "success", message: `OMS 已提交禁用 ${ids.length} 条记录，正在回读` });
  } else {
    await report(hooks, "onPhase", { phase: "oms_disabled", progress: 16, level: "success", message: "OMS 记录已经全部禁用，无需重复提交" });
  }
  const readback = await queryPage(page, normalizedItemId, hooks, false);
  const readbackMatching = readback.filter((record) => record.matchesItem);
  if (!readbackMatching.length || readbackMatching.some((record) => record.enabled !== false)) {
    throw Object.assign(new Error("OMS 禁用后回读仍存在启用记录"), { code: "oms_disable_readback_mismatch", itemId: normalizedItemId });
  }
  await report(hooks, "onReadback", { phase: "oms_disabled", method: "POST+GET", path: QUERY_PATH, status: 200, recordCount: readbackMatching.length });
  return {
    itemId: normalizedItemId,
    recordCount: readbackMatching.length,
    disabledRecordIds: matching.map((record) => record.id),
    changedRecordIds: targetRecords.map((record) => record.id),
    records: readbackMatching.map(({ raw, ...record }) => record),
  };
}

export { OMS_PAGE_URL, OMS_ORIGIN, QUERY_PATH as OMS_QUERY_PATH, TOGGLE_ENABLED_PATH as OMS_TOGGLE_ENABLED_PATH };