import crypto from "node:crypto";

const PUBLISH_PATH = "/tmall/submit.htm";
const ASYNC_OPT = "/tmall/asyncOpt.htm";
const PUBLISH_ORIGIN = "https://sell.publish.tmall.com";
const VALID_CHANNEL_OPTIONS = new Set(["1", "2"]);
const PUBLISH_PAGE_PATH = "/tmall/publish.htm";
const TEMP_READBACK_ATTEMPTS = 6;
const FINAL_READBACK_TIMEOUT_MS = 150_000;
const TEMP_READBACK_DELAY_MS = 500;
const FINAL_READBACK_DELAY_MS = 2_000;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value != null && String(value) !== "").map(String))];
}

function positiveSkuId(value) {
  return /^\d+$/.test(String(value ?? "")) && Number(value) > 0 ? String(value) : null;
}

function activeRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row && row.disabled !== true && row.action?.selected !== false);
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(input) {
  if (Array.isArray(input)) return input.map(canonicalize);
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonicalize(input[key])]));
}

function normalizeModelValue(model) {
  if (model?.value && typeof model.value === "object" && !Array.isArray(model.value)) return model.value;
  return model;
}

function normalizeGlobalModel(model) {
  if (!model || typeof model !== "object") return model;
  return { ...clone(model.value || {}), ...clone(model) };
}

function primitive(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function collectDataSourceValueIds(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectDataSourceValueIds(entry, output);
  } else if (value && typeof value === "object") {
    if (typeof value.value === "string" || typeof value.value === "number") output.push(String(value.value));
    if (value.dataSource) collectDataSourceValueIds(value.dataSource, output);
    if (value.options) collectDataSourceValueIds(value.options, output);
    if (value.children) collectDataSourceValueIds(value.children, output);
  }
  return output;
}

function normalizeSalePropMeta(rawSubItems) {
  const entries = Array.isArray(rawSubItems)
    ? rawSubItems.map((item) => [primitive(item?.key || item?.name || item?.propName || item?.dataIndex), item])
    : rawSubItems && typeof rawSubItems === "object" ? Object.entries(rawSubItems) : [];
  return entries.map(([mapKey, item]) => ({
    key: primitive(mapKey) || primitive(item?.key || item?.name || item?.propName || item?.dataIndex),
    label: primitive(item?.label || item?.title),
    uiType: primitive(item?.uiType || item?.type),
    required: item?.required === true,
    hasCustomProp: item?.hasCustomProp === true,
    isCustomSelectSaleProp: item?.isCustomSelectSaleProp === true,
    checkUrl: primitive(item?.checkUrl),
    propertyId: primitive(item?.propertyId) || primitive(mapKey).replace(/^p-/, ""),
    maxCustomItems: Number.isFinite(Number(item?.maxCustomItems)) ? Number(item.maxCustomItems) : null,
    maxLength: Number.isFinite(Number(item?.maxLength)) ? Number(item.maxLength) : null,
    dataSourceValueIds: [...new Set(collectDataSourceValueIds(item?.dataSource))],
  }));
}

function skuParamEntries(row) {
  return Object.entries(row || {}).filter(([key]) => /^skuParam_p-\d+$/.test(key));
}

function normalizedSkuParams(row) {
  return canonicalize(Object.fromEntries(skuParamEntries(row).map(([key, value]) => {
    const normalized = clone(value);
    if (normalized && typeof normalized === "object" && Object.hasOwn(normalized, "value")) {
      normalized.value = String(normalized.value ?? "");
    }
    return [key, normalized];
  })));
}

function rowDetailIdentity(row) {
  const salePropKey = rowSalePropKey(row);
  if (!salePropKey) return null;
  return `${salePropKey}|${JSON.stringify(normalizedSkuParams(row))}`;
}

export function detectPublishVariant(formValues, salePropMeta = []) {
  const rows = activeRows(formValues?.sku);
  const baseKeys = rows.map(rowSalePropKey).filter(Boolean);
  const hasSkuParams = rows.some((row) => skuParamEntries(row).length > 0);
  const hasDuplicateSalePropKeys = new Set(baseKeys).size !== baseKeys.length;
  const checkKeys = (Array.isArray(salePropMeta) ? salePropMeta : [])
    .filter((meta) => meta?.checkUrl && Array.isArray(formValues?.saleProp?.[meta.key]))
    .map((meta) => meta.key)
    .sort();
  return {
    kind: hasSkuParams || hasDuplicateSalePropKeys ? "sku_detail" : "standard_sku",
    hasSkuParams,
    hasDuplicateSalePropKeys,
    customCheckKeys: checkKeys,
  };
}

function hydrateServerSkuProps(formValues) {
  const next = clone(formValues);
  next.sku = activeRows(next.sku).map((row) => ({
    ...row,
    props: (Array.isArray(row?.props) ? row.props : []).map((prop) => {
      const candidates = Array.isArray(next.saleProp?.[prop?.name]) ? next.saleProp[prop.name] : [];
      const valueId = String(prop?.value ?? "").replace(/^-/, "");
      const match = candidates.find((entry) => String(entry?.value ?? "").replace(/^-/, "") === valueId)
        || candidates.find((entry) => String(entry?.text ?? "") === String(prop?.text ?? ""));
      return { ...clone(match || {}), ...clone(prop) };
    }),
  }));
  return next;
}

export function extractServerFormFromHtml(html) {
  const scripts = String(html || "").match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) || [];
  const script = scripts
    .map((value) => value.replace(/^<script\b[^>]*>|<\/script\s*>$/gi, ""))
    .find((value) => /window\.Json\s*=/.test(value));
  if (!script) throw Object.assign(new Error("服务端发布页缺少 window.Json 模型"), { code: "server_form_model_missing" });

  const assignment = script.match(/window\.Json\s*=\s*/);
  const start = assignment ? assignment.index + assignment[0].length : -1;
  const nextModel = start >= 0 ? script.indexOf("window.noIcmpJson", start) : -1;
  const end = nextModel >= 0 ? script.lastIndexOf(";", nextModel) : -1;
  if (start < 0 || end <= start) throw Object.assign(new Error("服务端发布页模型边界无法识别"), { code: "server_form_model_invalid" });

  let root;
  try {
    root = JSON.parse(script.slice(start, end).trim());
  } catch (error) {
    throw Object.assign(new Error("服务端发布页模型不是有效 JSON"), { code: "server_form_json_invalid", cause: error });
  }
  let formValues = normalizeModelValue(root?.models?.formValues);
  const global = normalizeGlobalModel(root?.models?.global);
  if (!formValues || !Array.isArray(formValues.sku)) {
    throw Object.assign(new Error("服务端发布页模型缺少 SKU 表单"), { code: "server_form_values_missing" });
  }
  if ((formValues.id == null || formValues.id === "") && global?.id != null) formValues.id = global.id;
  formValues = hydrateServerSkuProps(formValues);
  return {
    formValues,
    global,
    salePropMeta: root?.components?.saleProp?.props?.subItems || null,
  };
}

const TRANSIENT_SKU_FIELDS = new Set([
  "_originalIndex",
  "action",
  "cspuId",
  "errorInfo",
  "readonlyFields",
  "salePropKey",
  "skuId",
  "skuOldSku",
  "sourceSkuId",
  "suggestionInfo",
]);

function businessSkuRow(row, { ignoreStock = false } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (TRANSIENT_SKU_FIELDS.has(key) || key.startsWith("skuParam_p-") || (ignoreStock && key === "skuStock")) continue;
    result[key] = clone(value);
  }
  result.skuParams = normalizedSkuParams(row);
  result.disabled = row?.disabled === true;
  result.props = (Array.isArray(row?.props) ? row.props : []).map((prop) => ({
    name: String(prop?.name ?? ""),
    value: String(prop?.value ?? ""),
    text: String(prop?.text ?? ""),
    img: String(prop?.img ?? ""),
    pix: String(prop?.pix ?? ""),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (result.skuQuality && typeof result.skuQuality === "object") {
    result.skuQuality = { value: result.skuQuality.value ?? null, text: result.skuQuality.text ?? "" };
  }
  if (result.skuCustomize && typeof result.skuCustomize === "object") {
    result.skuCustomize = { value: result.skuCustomize.value ?? null, text: result.skuCustomize.text ?? "" };
  }
  return canonicalize(result);
}

function skuIdentity(row) {
  return { skuId: positiveSkuId(row?.skuId), ...businessSkuRow(row) };
}

function canonicalSalePropKeyFromProps(props) {
  const pairs = (Array.isArray(props) ? props : []).map((prop) => {
    const propertyId = String(prop?.name ?? "").replace(/^p-/, "");
    const rawValue = String(prop?.value ?? "");
    if (!/^\d+$/.test(propertyId) || !/^-?\d+$/.test(rawValue)) {
      throw Object.assign(new Error("销售属性组合包含无法识别的属性 ID"), { code: "sale_prop_identity_invalid" });
    }
    return `${propertyId}--${rawValue.replace(/^-/, "")}`;
  });
  if (!pairs.length || new Set(pairs).size !== pairs.length) {
    throw Object.assign(new Error("销售属性组合为空或包含重复属性"), { code: "sale_prop_identity_invalid" });
  }
  return pairs.sort().join("_");
}

function canonicalSalePropKey(value) {
  const pairs = String(value || "").split("_").filter(Boolean).map((pair) => {
    const match = pair.match(/^(\d+)(--?)(-?\d+)$/);
    if (!match) throw Object.assign(new Error(`销售属性组合键无效: ${pair || "空"}`), { code: "sale_prop_preview_identity_invalid" });
    const propertyId = match[1];
    const separator = match[2];
    const rawValue = match[3];
    const valueId = separator === "-" ? rawValue : rawValue.replace(/^-/, "");
    if (!/^\d+$/.test(valueId)) {
      throw Object.assign(new Error(`销售属性组合键无效: ${pair || "空"}`), { code: "sale_prop_preview_identity_invalid" });
    }
    return `${propertyId}--${valueId}`;
  });
  if (!pairs.length || new Set(pairs).size !== pairs.length) {
    throw Object.assign(new Error("销售属性预检组合键为空或重复"), { code: "sale_prop_preview_identity_invalid" });
  }
  return pairs.sort().join("_");
}

function rowSalePropKey(row) {
  const props = Array.isArray(row?.props) && row.props.length
    ? row.props
    : Object.entries(row || {})
      .filter(([key, value]) => key.startsWith("skuParam_p-") && value && typeof value === "object")
      .map(([key, value]) => ({ name: key.slice("skuParam_".length), value: value.value, text: value.text }));
  if (!props.length) return null;
  try { return canonicalSalePropKeyFromProps(props); } catch { return null; }
}

function mergeServerProps(fallbackProps, serverProps) {
  const fallback = Array.isArray(fallbackProps) ? fallbackProps : [];
  const byIdentity = new Map(fallback.map((prop) => [`${prop?.name}:${String(prop?.value ?? "").replace(/^-/, "")}`, prop]));
  const source = Array.isArray(serverProps) && serverProps.length ? serverProps : fallback;
  return source.map((prop) => {
    const identity = `${prop?.name}:${String(prop?.value ?? "").replace(/^-/, "")}`;
    return { ...clone(byIdentity.get(identity)), ...clone(prop) };
  });
}

function mergeServerSkuRows(fallbackRows, serverRows) {
  const fallback = activeRows(fallbackRows);
  const fallbackByKey = new Map();
  const fallbackByDetail = new Map();
  const keyCounts = new Map();
  const outerIdCounts = new Map();
  for (const row of fallback) {
    const outerId = String(row?.skuOuterId ?? "");
    if (outerId) outerIdCounts.set(outerId, (outerIdCounts.get(outerId) || 0) + 1);
  }
  const fallbackByOuterId = new Map();
  for (const [index, row] of fallback.entries()) {
    const key = rowSalePropKey(row);
    if (!key) throw Object.assign(new Error("服务端回读 SKU 组合无法与待提交状态一一匹配"), { code: "server_readback_mapping_failed" });
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    const detailIdentity = rowDetailIdentity(row);
    if (!detailIdentity || fallbackByDetail.has(detailIdentity)) {
      throw Object.assign(new Error("服务端回读 SKU 明细无法与待提交状态一一匹配"), { code: "server_readback_mapping_failed" });
    }
    fallbackByDetail.set(detailIdentity, index);
    const outerId = String(row?.skuOuterId ?? "");
    if (outerId && outerIdCounts.get(outerId) === 1) fallbackByOuterId.set(outerId, index);
  }
  for (const [index, row] of fallback.entries()) {
    const key = rowSalePropKey(row);
    if (keyCounts.get(key) === 1) fallbackByKey.set(key, index);
  }

  const seen = new Set();
  const merged = activeRows(serverRows).map((serverRow) => {
    const outerId = String(serverRow?.skuOuterId ?? "");
    const key = rowSalePropKey(serverRow);
    const detailIdentity = rowDetailIdentity(serverRow);
    const fallbackIndex = outerId && fallbackByOuterId.has(outerId)
      ? fallbackByOuterId.get(outerId)
      : detailIdentity && fallbackByDetail.has(detailIdentity)
        ? fallbackByDetail.get(detailIdentity)
        : key ? fallbackByKey.get(key) : null;
    const fallbackRow = fallbackIndex == null ? null : fallback[fallbackIndex];
    if (!fallbackRow || seen.has(fallbackIndex)) {
      throw Object.assign(new Error("服务端回读 SKU 组合缺失、重复或无法匹配"), { code: "server_readback_mapping_failed" });
    }
    seen.add(fallbackIndex);
    const merged = {
      ...clone(fallbackRow),
      ...clone(serverRow),
      props: mergeServerProps(fallbackRow.props, serverRow.props),
      salePropKey: key || rowSalePropKey(fallbackRow),
    };
    for (const [field, fallbackValue] of skuParamEntries(fallbackRow)) {
      const serverValue = serverRow?.[field];
      merged[field] = fallbackValue && typeof fallbackValue === "object" && serverValue && typeof serverValue === "object"
        ? { ...clone(fallbackValue), ...clone(serverValue) }
        : clone(serverValue ?? fallbackValue);
    }
    return merged;
  });
  if (seen.size !== fallback.length) {
    throw Object.assign(new Error("服务端回读 SKU 数量与待提交状态不一致"), { code: "server_readback_count_mismatch" });
  }
  return merged;
}

export function mergeServerForm(fallbackForm, serverForm) {
  if (!fallbackForm || !serverForm) throw Object.assign(new Error("服务端回读表单为空"), { code: "server_readback_form_missing" });
  return {
    ...clone(fallbackForm),
    ...clone(serverForm),
    sku: mergeServerSkuRows(fallbackForm.sku, serverForm.sku),
  };
}

function mergeServerGlobal(fallbackGlobal, serverGlobal) {
  const merged = { ...clone(fallbackGlobal || {}), ...clone(serverGlobal || {}) };
  if (fallbackGlobal?.value || serverGlobal?.value) {
    merged.value = { ...clone(fallbackGlobal?.value || {}), ...clone(serverGlobal?.value || {}) };
  }
  if (!merged.id && merged.value?.id) merged.id = merged.value.id;
  return merged;
}

function businessSaleProp(saleProp) {
  const result = {};
  for (const key of Object.keys(saleProp || {}).sort()) {
    const values = Array.isArray(saleProp[key]) ? saleProp[key] : [];
    result[key] = values.map((entry) => {
      const normalized = clone(entry) || {};
      if (Object.hasOwn(normalized, "value")) normalized.value = String(normalized.value);
      return canonicalize(normalized);
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return canonicalize(result);
}

function compareSaleProps(expected, actual) {
  return JSON.stringify(businessSaleProp(expected)) === JSON.stringify(businessSaleProp(actual));
}

function assertExactUniqueSkuIds(summary, expectedCount, code) {
  const ids = summary?.skuIds || [];
  if (ids.length !== expectedCount || new Set(ids).size !== expectedCount) {
    throw Object.assign(new Error(`SKU ID 必须是 ${expectedCount} 个互不重复的正整数`), {
      code,
      skuIds: ids,
      expectedCount,
    });
  }
  return ids;
}

function assertItemIdentity(state, pageUrl, itemId) {
  const expected = String(itemId);
  let urlItemId = null;
  try { urlItemId = new URL(pageUrl).searchParams.get("id"); } catch {}
  const identities = {
    url: urlItemId,
    global: state?.global?.id,
    form: state?.formValues?.id,
    icmpGlobal: state?.formValues?.icmp_global?.id,
  };
  if (identities.global == null || identities.global === "") {
    throw Object.assign(new Error("发布页未返回商品 ID，已停止写入"), { code: "item_identity_missing", expected, identities });
  }
  const mismatch = Object.values(identities).filter((value) => value != null && value !== "").some((value) => String(value) !== expected);
  if (mismatch) {
    throw Object.assign(new Error(`发布页商品 ID 与任务不一致，预期 ${expected}`), { code: "item_identity_mismatch", expected, identities });
  }
}

export function normalizeChannelOption(formValues, explicit) {
  const current = formValues?.channelOption?.value ?? formValues?.channelOption;
  const value = explicit == null || explicit === "" ? current : explicit;
  const normalized = typeof value === "object" ? value?.value : value;
  const result = String(normalized ?? "");
  if (!VALID_CHANNEL_OPTIONS.has(result)) {
    const error = new Error(`销售渠道值无效: ${result || "空"}，只允许 1 或 2`);
    error.code = "channel_option_invalid";
    throw error;
  }
  return { value: result };
}

export function classifySubmitResponse(status, bodyText) {
  let payload = null;
  try { payload = JSON.parse(bodyText || "{}"); } catch {}
  const formErrors = payload?.models?.formError || payload?.formError;
  const globalMessage = payload?.models?.globalMessage || payload?.globalMessage;
  if (status < 200 || status >= 300) {
    return { ok: false, code: "submit_http_error", businessCode: `HTTP_${status}`, message: `提交接口 HTTP ${status}`, payload };
  }
  if (formErrors && Object.keys(formErrors).length) {
    const first = Object.entries(formErrors).find(([, value]) => value);
    const message = first?.[1]?.message?.[0] || first?.[1]?.message || "页面字段校验失败";
    const detail = typeof message === "object" ? message : { msg: String(message) };
    return { ok: false, code: "submit_validation_error", businessCode: detail.code || "FORM_ERROR", message: detail.msg || detail.message || "页面字段校验失败", payload };
  }
  if (globalMessage?.type === "error" || globalMessage?.type === "fail") {
    return { ok: false, code: "submit_business_error", businessCode: globalMessage.code || "GLOBAL_ERROR", message: globalMessage.message || "提交接口返回业务错误", payload };
  }
  if (payload?.success === false || payload?.data?.success === false) {
    return { ok: false, code: "submit_business_error", businessCode: payload?.code || "BUSINESS_ERROR", message: payload?.message || "提交接口返回失败", payload };
  }
  if (globalMessage?.type === "success" || payload?.success === true || payload?.data?.success === true || payload?.data?.result === "success") {
    return { ok: true, code: "SUCCESS", businessCode: "SUCCESS", message: "提交接口返回成功", payload };
  }
  return { ok: false, code: "submit_response_unknown", businessCode: "UNKNOWN_RESPONSE", message: "提交响应无法确认成功，已停止自动流程", payload };
}

export function compareSkuRows(expectedRows, actualRows, { ignoreStock = false } = {}) {
  const expected = activeRows(expectedRows).map((row) => JSON.stringify(businessSkuRow(row, { ignoreStock }))).sort();
  const actual = activeRows(actualRows).map((row) => JSON.stringify(businessSkuRow(row, { ignoreStock }))).sort();
  const ignoredFields = ignoreStock ? ["skuStock"] : [];
  if (expected.length !== actual.length) return { equal: false, reason: `SKU 数量 ${actual.length} != ${expected.length}`, ignoredFields };
  if (JSON.stringify(expected) !== JSON.stringify(actual)) return { equal: false, reason: "SKU 业务字段与原快照不一致", ignoredFields };
  return { equal: true, reason: ignoreStock ? "SKU 字段一致（库存采用平台实时值）" : "SKU 字段一致", ignoredFields };
}

export function summarizeForm(formValues) {
  const rows = activeRows(formValues?.sku);
  const oldSkuIds = unique([
    ...rows.map((row) => positiveSkuId(row?.skuId)).filter(Boolean),
    ...(Array.isArray(formValues?.oldsku) ? formValues.oldsku.map((row) => positiveSkuId(row?.skuId)).filter(Boolean) : []),
  ]);
  return {
    skuCount: rows.length,
    skuIds: rows.map((row) => positiveSkuId(row?.skuId)).filter(Boolean),
    oldSkuIds,
    channelOption: normalizeChannelOption(formValues).value,
    sku: rows.map(skuIdentity),
    salePropKeys: Object.keys(formValues?.saleProp || {}),
  };
}

function inventoryMappingFromRow(row, resolved) {
  return {
    materialNo: String(resolved?.materialNo ?? row?.skuOuterId ?? "").trim(),
    barcode: String(resolved?.barcode ?? "").trim() || String(row?.skuBarcode ?? "").trim(),
    subMaterialName: String(resolved?.subMaterialName ?? "").trim(),
    specification: String(resolved?.specification ?? "").trim(),
  };
}

function applyInventoryResolution(formValues, resolution) {
  const rows = activeRows(formValues?.sku);
  const resolvedRows = Array.isArray(resolution?.rows) ? resolution.rows : Array.isArray(resolution) ? resolution : [];
  if (resolvedRows.length !== rows.length) {
    throw Object.assign(new Error(`Doris 返回 ${resolvedRows.length} 条 SKU 资料，预期 ${rows.length} 条`), { code: "inventory_resolution_count_mismatch" });
  }
  const mappings = rows.map((row, index) => {
    const mapping = inventoryMappingFromRow(row, resolvedRows[index]);
    if (!mapping.materialNo || !mapping.subMaterialName || !mapping.specification) {
      throw Object.assign(new Error(`SKU ${positiveSkuId(row?.skuId) || index + 1} 缺少料号、品名或规格资料`), { code: "inventory_resolution_incomplete", index });
    }
    if (!mapping.barcode && !String(row?.skuBarcode ?? "").trim()) {
      throw Object.assign(new Error(`SKU ${positiveSkuId(row?.skuId) || index + 1} 缺少可用 69 码`), { code: "inventory_barcode_missing", index, materialNo: mapping.materialNo });
    }
    if (!String(row?.skuBarcode ?? "").trim() && mapping.barcode) row.skuBarcode = mapping.barcode;
    return mapping;
  });
  return mappings;
}

function uniqueToken(task) {
  const suffix = crypto.createHash("sha256").update(`${task.id}:${task.itemId}:${Date.now()}`).digest("hex").slice(0, 10);
  return `TMALL_REBUILD_${suffix}`;
}

function chooseTemporaryProperty(formValues, salePropMeta) {
  const saleProp = formValues?.saleProp || {};
  const keys = Object.keys(saleProp);
  if (!keys.length) throw Object.assign(new Error("商品没有可重建的销售属性"), { code: "sale_prop_missing" });
  const metadata = new Map((Array.isArray(salePropMeta) ? salePropMeta : []).map((item) => [String(item?.key || ""), item]));
  const candidates = keys.map((key) => {
    const meta = metadata.get(key);
    const originalValues = Array.isArray(saleProp[key]) ? saleProp[key] : [];
    const maxCustomItems = Number(meta?.maxCustomItems);
    const hasCustomLimit = meta?.maxCustomItems != null;
    const withinCustomLimit = !hasCustomLimit || (Number.isFinite(maxCustomItems) && maxCustomItems >= originalValues.length);
    const dataSourceValueIds = new Set(meta?.dataSourceValueIds || []);
    const hasExistingCustomValue = originalValues.some((value) => /^-\d+$/.test(String(value?.value ?? "")) && !dataSourceValueIds.has(String(value.value)));
    const supportsCustomValue = meta?.hasCustomProp === true || meta?.isCustomSelectSaleProp === true || hasExistingCustomValue;
    return { key, meta, originalValues, withinCustomLimit, hasExistingCustomValue, supportsCustomValue };
  }).filter(({ meta, originalValues, withinCustomLimit, supportsCustomValue }) => meta && supportsCustomValue && originalValues.length > 0 && withinCustomLimit);
  candidates.sort((a, b) => {
    if (Boolean(a.meta.checkUrl) !== Boolean(b.meta.checkUrl)) return a.meta.checkUrl ? 1 : -1;
    const aScore = (a.hasExistingCustomValue ? 8 : 0) + (a.meta.required === true ? 0 : 4) + (a.meta.hasCustomProp === true ? 2 : 0);
    const bScore = (b.hasExistingCustomValue ? 8 : 0) + (b.meta.required === true ? 0 : 4) + (b.meta.hasCustomProp === true ? 2 : 0);
    return bScore - aScore || a.key.localeCompare(b.key);
  });
  const candidate = candidates[0];
  if (!candidate) {
    throw Object.assign(new Error("没有找到页面明确允许自定义值且容量足够的销售属性"), { code: "sale_prop_custom_value_unsupported" });
  }
  const configuredMaxLength = Number(candidate.meta.maxLength);
  const maxLength = Number.isFinite(configuredMaxLength) && configuredMaxLength > 0 ? Math.floor(configuredMaxLength) : 30;
  if (maxLength < 1) throw Object.assign(new Error(`销售属性 ${candidate.key} 不允许填写自定义值`), { code: "sale_prop_custom_value_unsupported" });
  return { ...candidate, maxLength: Math.min(maxLength, 30) };
}

function buildTemporaryForm(formValues, task, salePropMeta) {
  const next = clone(formValues);
  const { key, originalValues, maxLength, meta } = chooseTemporaryProperty(formValues, salePropMeta);
  const token = uniqueToken(task);
  const usedValueIds = new Set(Object.values(formValues?.saleProp || {}).flatMap((values) => Array.isArray(values) ? values.map((value) => String(value?.value ?? "")) : []));
  let valueId = -(100_000_000 + (Number.parseInt(crypto.createHash("sha256").update(token).digest("hex").slice(0, 8), 16) % 800_000_000));
  while (originalValues.some((_, index) => usedValueIds.has(String(valueId - index)))) valueId -= originalValues.length + 1;
  const suffix = token.slice(-10);
  const usedTexts = new Set();
  const temporaryValues = originalValues.map((value, index) => ({
    ...value,
    value: valueId - index,
    text: `${suffix}${index.toString(36)}`.slice(-maxLength),
  }));
  for (const value of temporaryValues) {
    const text = String(value.text || "");
    if (!text || text.length > maxLength || usedTexts.has(text)) {
      throw Object.assign(new Error(`销售属性 ${key} 无法在 ${maxLength} 字符限制内生成唯一临时值`), { code: "sale_prop_custom_length_invalid" });
    }
    usedTexts.add(text);
  }
  next.saleProp = { ...next.saleProp, [key]: temporaryValues };
  next.sku = activeRows(formValues.sku).map((row, index) => {
    const updated = clone(row);
    const currentProp = (updated.props || []).find((prop) => prop.name === key);
    if (!currentProp) throw Object.assign(new Error(`SKU 缺少销售属性 ${key}`), { code: "sale_prop_row_mapping_failed" });
    let matches = originalValues.map((value, valueIndex) => ({ value, valueIndex })).filter(({ value }) => String(value?.value ?? "") === String(currentProp.value ?? ""));
    if (!matches.length) matches = originalValues.map((value, valueIndex) => ({ value, valueIndex })).filter(({ value }) => String(value?.text ?? "") === String(currentProp.text ?? ""));
    if (matches.length !== 1) throw Object.assign(new Error(`SKU 无法唯一映射销售属性 ${key}`), { code: "sale_prop_row_mapping_failed" });
    const valueIndex = matches[0].valueIndex;
    const selected = temporaryValues[valueIndex];
    updated.skuId = null;
    updated.skuOldSku = null;
    updated.sourceSkuId = null;
    updated.skuOuterId = `${token}_${index + 1}`;
    updated.skuBarcode = "";
    updated.props = (updated.props || []).map((prop) => prop.name === key ? { ...prop, value: selected.value, text: selected.text } : prop);
    const skuParamKey = `skuParam_${key}`;
    const currentSkuParam = updated[skuParamKey];
    const skuParamMirrorsProp = currentSkuParam && typeof currentSkuParam === "object"
      && String(currentSkuParam.value ?? "").replace(/^-/, "") === String(currentProp.value ?? "").replace(/^-/, "");
    if (skuParamMirrorsProp) {
      const normalizedValue = String(selected.value ?? "").replace(/^-/, "");
      updated[skuParamKey] = {
        ...currentSkuParam,
        value: typeof currentSkuParam.value === "number" ? Number(normalizedValue) : normalizedValue,
        text: selected.text,
      };
    }
    updated.salePropKey = canonicalSalePropKeyFromProps(updated.props);
    return updated;
  });
  return { formValues: next, key, token, meta: clone(meta), temporaryValues };
}

function buildRestoreForm(original, current, token) {
  const temporaryRows = current.sku;
  const next = clone(current);
  next.saleProp = clone(original.saleProp);
  next.channelOption = clone(original.channelOption);
  const generatedIds = activeRows(original.sku).map((_, index) => {
    const expectedOuterId = `${token}_${index + 1}`;
    const match = activeRows(temporaryRows).find((row) => String(row?.skuOuterId ?? "") === expectedOuterId);
    return positiveSkuId(match?.skuId);
  });
  if (generatedIds.length !== activeRows(original.sku).length || generatedIds.some((value) => !value)) {
    throw Object.assign(new Error("临时提交未返回可用的新 SKU ID"), { code: "temporary_ids_missing" });
  }
  next.sku = activeRows(original.sku).map((row, index) => {
    const restored = clone(row);
    restored.skuId = generatedIds[index];
    restored.skuOldSku = null;
    restored.sourceSkuId = null;
    return restored;
  });
  return next;
}

function requestContext(page) {
  const context = page?.context?.();
  if (!context?.request?.fetch || typeof context.cookies !== "function") {
    throw Object.assign(new Error("浏览器登录态接口不可用"), { code: "browser_api_context_unavailable" });
  }
  return context;
}

async function apiFetch(page, url, { method = "GET", body = null, headers = {}, timeout = 45_000 } = {}) {
  const context = requestContext(page);
  const requestHeaders = {
    Accept: method === "GET" ? "text/html,application/xhtml+xml" : "application/json, text/plain, */*",
    Referer: `${PUBLISH_ORIGIN}/`,
    ...headers,
  };
  if (body != null) {
    requestHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    requestHeaders["X-Requested-With"] = "XMLHttpRequest";
    const cookies = await context.cookies(PUBLISH_ORIGIN);
    const encodedToken = cookies.find((cookie) => cookie.name === "XSRF-TOKEN")?.value || "";
    let xsrfToken = encodedToken;
    try { xsrfToken = decodeURIComponent(encodedToken); } catch {}
    if (xsrfToken) requestHeaders["X-XSRF-TOKEN"] = xsrfToken;
  }
  const response = await context.request.fetch(url, {
    method,
    headers: requestHeaders,
    data: body == null ? undefined : body.toString(),
    timeout,
    failOnStatusCode: false,
  });
  return { status: response.status(), text: await response.text(), url: response.url() };
}

async function fetchServerReadback(page, baseUrl) {
  const result = await apiFetch(page, baseUrl);
  if (result.status < 200 || result.status >= 300) {
    throw Object.assign(new Error(`服务端回读 HTTP ${result.status}`), { code: "server_readback_http_error", status: result.status });
  }
  return { ...extractServerFormFromHtml(result.text), status: result.status };
}

async function fetchInitialState(page, baseUrl) {
  const parsed = await fetchServerReadback(page, baseUrl);
  const globalValues = parsed.global?.value && typeof parsed.global.value === "object" ? clone(parsed.global.value) : {};
  const formValues = {
    ...globalValues,
    ...clone(parsed.formValues),
    icmp_global: { ...globalValues, ...clone(parsed.formValues?.icmp_global || {}) },
  };
  return {
    ready: true,
    formValues,
    global: parsed.global,
    channelData: null,
    salePropMeta: normalizeSalePropMeta(parsed.salePropMeta),
    detailVariant: detectPublishVariant(formValues, normalizeSalePropMeta(parsed.salePropMeta)),
  };
}

async function loadReadback(page, baseUrl, fallbackState, phase, accepts, timing = {}) {
  const now = typeof timing.now === "function" ? timing.now : Date.now;
  const sleep = typeof timing.sleep === "function"
    ? timing.sleep
    : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
  const finalReadbackDelayMs = Number.isFinite(Number(timing.finalDelayMs)) && Number(timing.finalDelayMs) > 0
    ? Number(timing.finalDelayMs)
    : FINAL_READBACK_DELAY_MS;
  const startedAt = now();
  const finalDeadlineAt = startedAt + FINAL_READBACK_TIMEOUT_MS;
  const finalPhase = phase === "final_readback";
  let attempt = 0;
  let lastState = null;
  let lastError = null;
  while (finalPhase || attempt < TEMP_READBACK_ATTEMPTS) {
    const deadlineReadback = finalPhase && now() >= finalDeadlineAt;
    attempt += 1;
    try {
      const parsed = await fetchServerReadback(page, baseUrl);
      const salePropMeta = normalizeSalePropMeta(parsed.salePropMeta) || fallbackState?.salePropMeta || [];
      const mergedForm = mergeServerForm(fallbackState?.formValues, parsed.formValues);
      lastState = {
        ready: true,
        formValues: mergedForm,
        global: mergeServerGlobal(fallbackState?.global, parsed.global),
        channelData: null,
        salePropMeta,
        detailVariant: detectPublishVariant(mergedForm, salePropMeta),
        readback: {
          phase,
          method: "GET",
          path: PUBLISH_PAGE_PATH,
          status: parsed.status,
          durationMs: now() - startedAt,
          strategy: "api_server_bootstrap",
          attempts: attempt,
          settled: false,
          ...(finalPhase ? { deadlineMs: FINAL_READBACK_TIMEOUT_MS, deadlineReadback } : {}),
        },
      };
      if (!accepts || accepts(lastState)) {
        lastState.readback.settled = true;
        return lastState;
      }
    } catch (error) {
      lastError = error;
    }
    if (finalPhase) {
      if (deadlineReadback) break;
      const remainingMs = finalDeadlineAt - now();
      if (remainingMs > 0) await sleep(Math.min(finalReadbackDelayMs, remainingMs));
    } else {
      if (attempt >= TEMP_READBACK_ATTEMPTS) break;
      await sleep(TEMP_READBACK_DELAY_MS);
    }
  }
  if (lastState) return lastState;
  throw Object.assign(new Error(`纯接口回读失败: ${lastError?.message || "未知错误"}`), {
    code: lastError?.code || "server_readback_failed",
    cause: lastError,
  });
}

function customCheckMessage(payload) {
  const message = payload?.models?.globalMessage || payload?.globalMessage || {};
  const first = Array.isArray(message.message) ? message.message[0] : message.message;
  return typeof first === "object" ? first?.msg || first?.message : first;
}

async function validateCustomSalePropValues(page, candidate, values, global, baseUrl) {
  const checkUrl = String(candidate?.meta?.checkUrl || "");
  if (!checkUrl) return [];
  let endpoint;
  try { endpoint = new URL(checkUrl, baseUrl); } catch (cause) {
    throw Object.assign(new Error("自定义销售属性异步校验地址无效"), { code: "sale_prop_custom_check_invalid", cause });
  }
  const optType = endpoint.searchParams.get("optType") || "";
  if (endpoint.origin !== PUBLISH_ORIGIN || endpoint.pathname !== "/tmall/asyncOpt.htm" || !/^tmall_new_check_custom_[a-z0-9_]+$/i.test(optType)) {
    throw Object.assign(new Error("自定义销售属性异步校验地址不在允许范围内"), { code: "sale_prop_custom_check_invalid" });
  }
  const propertyId = String(candidate.meta.propertyId || candidate.key.replace(/^p-/, ""));
  endpoint.searchParams.set("pid", propertyId);
  const texts = [...new Set((values || []).map((value) => String(value?.text ?? "")).filter(Boolean))];
  const checks = [];
  for (const text of texts) {
    const body = new URLSearchParams(endpoint.searchParams);
    body.set("jsonBody", JSON.stringify({ text }));
    body.set("globalExtendInfo", String(globalField(global, "globalExtendInfo") ?? ""));
    const startedAt = Date.now();
    const result = await apiFetch(page, endpoint.toString(), { method: "POST", body, headers: { Referer: baseUrl } });
    let payload = null;
    try { payload = JSON.parse(result.text || "{}"); } catch {}
    const globalMessage = payload?.models?.globalMessage || payload?.globalMessage || {};
    const type = String(globalMessage.type || "").toLowerCase();
    const rejected = result.status < 200 || result.status >= 300
      || type === "error" || type === "fail"
      || payload?.success === false || payload?.data?.success === false;
    const accepted = type === "success" || payload?.success === true || payload?.data?.success === true;
    if (rejected || !accepted) {
      throw Object.assign(new Error(customCheckMessage(payload) || payload?.message || `自定义销售属性校验失败（HTTP ${result.status}）`), {
        code: rejected ? "sale_prop_custom_check_rejected" : "sale_prop_custom_check_unknown",
        status: result.status,
        propertyId,
      });
    }
    checks.push({ path: "/tmall/asyncOpt.htm", method: "POST", status: result.status, durationMs: Date.now() - startedAt, businessCode: "SUCCESS" });
  }
  return checks;
}

function normalizePreviewRows(payload) {
  const raw = payload?.data?.value ?? payload?.data?.sku ?? payload?.data?.rows ?? payload?.models?.sku ?? payload?.value;
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return null;
  const entries = Object.values(raw);
  if (entries.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) return entries;
  if (entries.every(Array.isArray)) return entries.flat();
  return null;
}

async function previewSalePropValues(page, formValues, global) {
  const endpoint = new URL(`${ASYNC_OPT}?optType=salePropValueChangeAsync&catId=${global?.catId || ""}&requiredKey=keyProp&brandId=${global?.brand?.brandId || ""}&itemId=${global?.id || ""}&spuId=${global?.spuApply || ""}`, PUBLISH_ORIGIN).toString();
  const body = new URLSearchParams({ itemId: String(global?.id || ""), jsonBody: JSON.stringify(formValues), globalExtendInfo: global?.globalExtendInfo || "" });
  const result = await apiFetch(page, endpoint, { method: "POST", body });
  let payload;
  try { payload = JSON.parse(result.text || "{}"); } catch { payload = null; }
  const rows = normalizePreviewRows(payload);
  const success = payload?.success === true || payload?.data?.success === true || payload?.models?.globalMessage?.type === "success";
  if (result.status < 200 || result.status >= 300 || !success || !Array.isArray(rows)) {
    throw Object.assign(new Error("销售属性预检未返回 SKU 组合"), { code: "sale_prop_preview_failed", status: result.status, response: payload });
  }
  return { endpoint, status: result.status, rows };
}

function mergePreviewRows(desiredRows, previewRows) {
  if (!Array.isArray(previewRows) || !previewRows.length) {
    throw Object.assign(new Error("销售属性预检未返回 SKU 组合"), { code: "sale_prop_preview_count_mismatch", expected: desiredRows.length, actual: previewRows?.length || 0 });
  }
  const desiredByKey = new Map();
  for (const desired of desiredRows) {
    const key = canonicalSalePropKeyFromProps(desired?.props);
    const group = desiredByKey.get(key) || [];
    group.push(desired);
    desiredByKey.set(key, group);
  }
  const previewByKey = new Map();
  for (const preview of previewRows) {
    const key = canonicalSalePropKey(preview?.salePropKey);
    const group = previewByKey.get(key) || [];
    group.push(preview);
    previewByKey.set(key, group);
  }
  const desiredKeys = [...desiredByKey.keys()].sort();
  const previewKeys = [...previewByKey.keys()].sort();
  const missing = desiredKeys.filter((key) => !previewByKey.has(key));
  const extra = previewKeys.filter((key) => !desiredByKey.has(key));
  const placeholderOnlyExtra = extra.every((key) => previewByKey.get(key).every((row) => !positiveSkuId(row?.skuId)
    && skuParamEntries(row).length === 0
    && !row?.skuOuterId
    && !row?.skuBarcode));
  if (missing.length || (extra.length && !placeholderOnlyExtra)) {
    throw Object.assign(new Error(`销售属性预检组合与商品明细不一致：缺少 ${missing.length} 个，新增 ${extra.length} 个`), {
      code: "sale_prop_preview_count_mismatch",
      expected: desiredRows.length,
      actual: previewRows.length,
      missing,
      extra,
    });
  }
  const mergedRows = [];
  for (const desiredKey of desiredKeys) {
    const desiredGroup = desiredByKey.get(desiredKey);
    const previewGroup = previewByKey.get(desiredKey);
    if (previewGroup.length > desiredGroup.length) {
      throw Object.assign(new Error(`销售属性预检返回重复组合: ${desiredKey}`), { code: "sale_prop_preview_duplicate" });
    }
    if (previewGroup.length !== 1 && previewGroup.length !== desiredGroup.length) {
      throw Object.assign(new Error(`销售属性预检明细数量无法匹配: ${desiredKey}`), { code: "sale_prop_preview_count_mismatch", expected: desiredGroup.length, actual: previewGroup.length });
    }
    const previewFingerprints = previewGroup.map((row) => canonicalize(Object.fromEntries(Object.entries(row || {}).filter(([key]) => key !== "salePropKey" && key !== "skuId" && key !== "skuOldSku" && key !== "sourceSkuId" && key !== "action" && key !== "props" && !key.startsWith("skuParam_p-")))));
    const homogeneousPreview = previewFingerprints.every((fingerprint) => JSON.stringify(fingerprint) === JSON.stringify(previewFingerprints[0]));
    const previewForRow = previewGroup.length === 1
      ? () => previewGroup[0]
      : homogeneousPreview
        ? () => previewGroup[0]
      : (() => {
        const byDetail = new Map(previewGroup.map((row) => [rowDetailIdentity(row), row]));
        if ([...byDetail.keys()].some((key) => !key) || byDetail.size !== previewGroup.length) {
          throw Object.assign(new Error(`销售属性预检明细无法一一映射: ${desiredKey}`), { code: "sale_prop_preview_mapping_failed" });
        }
        return (desired) => byDetail.get(rowDetailIdentity(desired));
      })();
    for (const desired of desiredGroup) {
      const preview = previewForRow(desired);
      if (!preview) throw Object.assign(new Error(`销售属性预检缺少 SKU 明细: ${rowDetailIdentity(desired)}`), { code: "sale_prop_preview_mapping_failed" });
      const merged = { ...clone(preview), ...clone(desired) };
      merged.salePropKey = preview.salePropKey;
      merged.skuId = null;
      merged.skuOldSku = null;
      merged.sourceSkuId = null;
      merged.skuPrice = desired.skuPrice;
      merged.skuStock = desired.skuStock;
      merged.skuOuterId = desired.skuOuterId;
      merged.skuBarcode = desired.skuBarcode;
      merged.skuStatus = desired.skuStatus;
      merged.status = desired.status;
      merged.action = { selected: true };
      mergedRows.push(merged);
    }
  }
  return mergedRows;
}

function prewriteStateError(phase, reason) {
  const label = phase === "temporary" ? "临时提交" : "最终恢复提交";
  return Object.assign(new Error(`${label}前页内状态校验失败：${reason}`), {
    code: `${phase}_prewrite_state_mismatch`,
    phase,
    reason,
  });
}

function prewriteCombinations(rows, phase) {
  try {
    const combinations = activeRows(rows).map((row) => {
      const propsKey = canonicalSalePropKeyFromProps(row?.props);
      const storedKey = canonicalSalePropKey(row?.salePropKey);
      if (propsKey !== storedKey) throw new Error("salePropKey 与 props 不一致");
      const identity = rowDetailIdentity(row);
      if (!identity) throw new Error("SKU 明细缺少可识别的销售属性组合");
      return { key: propsKey, identity, row };
    });
    if (new Set(combinations.map(({ identity }) => identity)).size !== combinations.length) {
      throw new Error("SKU 明细组合重复");
    }
    return combinations;
  } catch (cause) {
    if (cause?.code === `${phase}_prewrite_state_mismatch`) throw cause;
    throw prewriteStateError(phase, cause?.message || "销售属性组合无法识别");
  }
}

function assertSameCombinationSet(expected, actual, phase) {
  const expectedKeys = expected.map(({ identity }) => identity).sort();
  const actualKeys = actual.map(({ identity }) => identity).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw prewriteStateError(phase, "销售属性组合与构造状态不一致");
  }
}

function assertSameChannel(expected, actual, phase) {
  let expectedChannel;
  let actualChannel;
  try {
    expectedChannel = normalizeChannelOption(expected).value;
    actualChannel = normalizeChannelOption(actual).value;
  } catch {
    throw prewriteStateError(phase, "销售渠道值无效");
  }
  if (expectedChannel !== actualChannel) throw prewriteStateError(phase, "销售渠道与构造状态不一致");
}

function validateTemporaryPrewrite(expectedForm, actualForm, token) {
  const phase = "temporary";
  const expectedRows = activeRows(expectedForm?.sku);
  const actualRows = activeRows(actualForm?.sku);
  if (actualRows.length !== expectedRows.length) throw prewriteStateError(phase, "SKU 数量与构造状态不一致");
  if (!compareSaleProps(expectedForm?.saleProp, actualForm?.saleProp)) throw prewriteStateError(phase, "销售属性与构造状态不一致");
  assertSameChannel(expectedForm, actualForm, phase);
  const expectedCombinations = prewriteCombinations(expectedRows, phase);
  const actualCombinations = prewriteCombinations(actualRows, phase);
  assertSameCombinationSet(expectedCombinations, actualCombinations, phase);
  if (actualRows.some((row) => row.skuId !== null || row.skuOldSku !== null || row.sourceSkuId !== null)) {
    throw prewriteStateError(phase, "SKU 身份字段未清空");
  }
  const expectedOuterIds = expectedRows.map((_, index) => `${token}_${index + 1}`).sort();
  const actualOuterIds = actualRows.map((row) => String(row?.skuOuterId ?? "")).sort();
  if (new Set(actualOuterIds).size !== actualRows.length || JSON.stringify(actualOuterIds) !== JSON.stringify(expectedOuterIds)) {
    throw prewriteStateError(phase, "临时商家编码不唯一或与任务令牌不匹配");
  }
  if (actualRows.some((row) => row.skuBarcode !== "")) throw prewriteStateError(phase, "临时条码未清空");
  const comparison = compareSkuRows(expectedRows, actualRows);
  if (!comparison.equal) throw prewriteStateError(phase, comparison.reason);
}

function validateFinalPrewrite(expectedForm, actualForm, generatedIds) {
  const phase = "final";
  const expectedRows = activeRows(expectedForm?.sku);
  const actualRows = activeRows(actualForm?.sku);
  if (actualRows.length !== expectedRows.length) throw prewriteStateError(phase, "SKU 数量与构造状态不一致");
  if (!compareSaleProps(expectedForm?.saleProp, actualForm?.saleProp)) throw prewriteStateError(phase, "销售属性与原快照不一致");
  assertSameChannel(expectedForm, actualForm, phase);
  const expectedCombinations = prewriteCombinations(expectedRows, phase);
  const actualCombinations = prewriteCombinations(actualRows, phase);
  assertSameCombinationSet(expectedCombinations, actualCombinations, phase);
  const comparison = compareSkuRows(expectedRows, actualRows);
  if (!comparison.equal) throw prewriteStateError(phase, comparison.reason);
  const expectedIds = expectedRows.map((row) => positiveSkuId(row?.skuId));
  const actualIds = actualRows.map((row) => positiveSkuId(row?.skuId));
  const generatedSet = [...generatedIds].sort();
  if (expectedIds.some((id) => !id) || actualIds.some((id) => !id)
    || new Set(expectedIds).size !== expectedRows.length || new Set(actualIds).size !== actualRows.length
    || JSON.stringify([...expectedIds].sort()) !== JSON.stringify(generatedSet)
    || JSON.stringify([...actualIds].sort()) !== JSON.stringify(generatedSet)) {
    throw prewriteStateError(phase, "新 SKU ID 集合不精确");
  }
  const expectedIdByCombination = new Map(expectedCombinations.map(({ identity, row }) => [identity, positiveSkuId(row?.skuId)]));
  if (actualCombinations.some(({ identity, row }) => expectedIdByCombination.get(identity) !== positiveSkuId(row?.skuId))) {
    throw prewriteStateError(phase, "新 SKU ID 与销售属性组合的映射不一致");
  }
  if (actualRows.some((row) => row.skuOldSku !== null || row.sourceSkuId !== null)) {
    throw prewriteStateError(phase, "最终 SKU 来源身份字段未清空");
  }
}

function globalField(global, name) {
  return global?.[name] ?? global?.value?.[name];
}

export function buildSubmitBody(formValues, global) {
  const itemId = globalField(global, "id") ?? formValues?.id;
  const catId = globalField(global, "catId") ?? formValues?.catId;
  const traceId = formValues?.gpfRenderTrace || globalField(global, "gpfRenderTrace");
  if (!itemId || !catId || !traceId) {
    throw Object.assign(new Error("纯接口提交缺少商品、类目或渲染跟踪字段"), { code: "submit_contract_incomplete" });
  }
  const body = new URLSearchParams();
  for (const name of ["isLightCombine", "isSetsCombine", "combineToNormal", "tmSpuPublishType", "isUnBondedGift", "spu_qf_param"]) {
    const value = globalField(global, name);
    body.set(name, value == null ? "null" : String(value));
  }
  const optional = {
    roleType: globalField(global, "roleType"),
    globalScmExtendInfo: globalField(global, "scmExtendInfo"),
    globalBizExtendInfo: globalField(global, "bizExtendInfo"),
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value != null && value !== "") body.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }
  body.set("catId", String(catId));
  body.set("itemId", String(itemId));
  body.set("jsonBody", JSON.stringify(formValues));
  body.set("globalExtendInfo", String(globalField(global, "globalExtendInfo") ?? globalField(global, "scUrlDataComp") ?? ""));
  return { body, itemId: String(itemId), traceId: String(traceId) };
}

async function submitThroughApi(page, formValues, global, baseUrl) {
  const contract = buildSubmitBody(formValues, global);
  const endpoint = new URL(PUBLISH_PATH, PUBLISH_ORIGIN).toString();
  const result = await apiFetch(page, endpoint, {
    method: "POST",
    body: contract.body,
    timeout: 20_000,
    headers: {
      Referer: baseUrl,
      "x-gpf-renderId": contract.traceId,
      "x-gpf-type": "1",
    },
  });
  return {
    classification: classifySubmitResponse(result.status, result.text),
    requestPath: PUBLISH_PATH,
    status: result.status,
  };
}

export async function executeTmallRebuild(page, task, hooks = {}) {
  let writeAttempted = false;
  const hookErrors = [];
  const invokeHook = async (name, payload) => {
    const callback = hooks[name];
    if (typeof callback !== "function") return;
    try {
      await callback(payload);
    } catch (cause) {
      const issue = { hook: name, phase: payload?.phase || "unknown", message: cause?.message || String(cause) };
      if (!writeAttempted) {
        throw Object.assign(new Error(`写入前状态持久化失败: ${issue.message}`), { code: "prewrite_hook_failed", hook: name, cause });
      }
      hookErrors.push(issue);
    }
  };
  const reportPhase = (phase, message, level, progress) => invokeHook("onPhase", { phase, message, level, progress });
  const baseUrl = `https://sell.publish.tmall.com/tmall/publish.htm?id=${encodeURIComponent(task.itemId)}`;
  if (!page || page.isClosed()) throw Object.assign(new Error("专属 Edge 页面不可用"), { code: "browser_page_unavailable" });
  let state = await fetchInitialState(page, baseUrl);
  assertItemIdentity(state, baseUrl, task.itemId);
  const original = clone(state.formValues);
  let inventoryMappings = activeRows(original.sku).map((row) => inventoryMappingFromRow(row, row));
  if (typeof hooks.resolveInventory === "function") {
    let resolution;
    try {
      resolution = await hooks.resolveInventory(activeRows(original.sku).map(clone), { itemId: String(task.itemId), requireBarcode: true });
      inventoryMappings = applyInventoryResolution(original, resolution);
    } catch (cause) {
      throw Object.assign(new Error(cause?.message || "Doris SKU 资料解析失败"), { code: cause?.code || "inventory_resolution_failed", cause });
    }
    await invokeHook("onInventory", {
      phase: "resolved",
      mappings: inventoryMappings.map(({ materialNo, subMaterialName, specification }) => ({ materialNo, subMaterialName, specification })),
    });
  }
  const channelOption = normalizeChannelOption(original);
  original.channelOption = channelOption;
  const originalSummary = summarizeForm(original);
  originalSummary.detailVariant = clone(state.detailVariant || detectPublishVariant(original, state.salePropMeta));
  task.detailVariant = originalSummary.detailVariant;
  if (!originalSummary.skuCount) throw Object.assign(new Error("商品没有可处理的 SKU"), { code: "sku_rows_missing" });
  assertExactUniqueSkuIds(originalSummary, originalSummary.skuCount, "sku_snapshot_id_invalid");
  if (task.expectedSkuCount != null && Number(task.expectedSkuCount) !== originalSummary.skuCount) {
    throw Object.assign(new Error(`预期 ${task.expectedSkuCount} 个 SKU，页面实际为 ${originalSummary.skuCount} 个`), { code: "sku_count_mismatch", expected: Number(task.expectedSkuCount), actual: originalSummary.skuCount });
  }
  const requestedSkuIdList = Array.isArray(task.skuIds) ? task.skuIds.map((value) => String(value)) : [];
  if (requestedSkuIdList.some((value) => !positiveSkuId(value)) || new Set(requestedSkuIdList).size !== requestedSkuIdList.length) {
    throw Object.assign(new Error("输入的 SKU ID 必须是互不重复的正整数"), { code: "sku_snapshot_mismatch", expected: task.skuIds, actual: originalSummary.skuIds });
  }
  const requestedSkuIds = [...requestedSkuIdList].sort();
  const actualSkuIds = [...originalSummary.skuIds].sort();
  if (requestedSkuIds.length && JSON.stringify(requestedSkuIds) !== JSON.stringify(actualSkuIds)) {
    throw Object.assign(new Error("输入的 SKU ID 与页面当前快照不一致"), { code: "sku_snapshot_mismatch", expected: task.skuIds, actual: originalSummary.skuIds });
  }
  const recoverySnapshot = {
    itemId: String(task.itemId),
    sku: clone(original.sku),
    saleProp: clone(original.saleProp),
    oldsku: clone(original.oldsku || []),
    channelOption: clone(original.channelOption),
  };
  recoverySnapshot.sha256 = canonicalHash(recoverySnapshot);
  await invokeHook("onRecoverySnapshot", recoverySnapshot);
  await invokeHook("onSnapshot", { phase: "before", summary: originalSummary });
  const variantLabel = originalSummary.detailVariant.kind === "sku_detail" ? "SKU 明细结构" : "标准 SKU 结构";
  const customCheckLabel = originalSummary.detailVariant.customCheckKeys.length ? `，${originalSummary.detailVariant.customCheckKeys.length} 个销售属性需异步校验` : "";
  await reportPhase("reading_snapshot", `已读取商品快照：${originalSummary.skuCount} 个 SKU（${variantLabel}${customCheckLabel}）`, "info", 12);

  const temporary = buildTemporaryForm(original, task, state.salePropMeta);
  const customChecks = await validateCustomSalePropValues(page, temporary, temporary.temporaryValues, state.global, baseUrl);
  for (const check of customChecks) {
    await invokeHook("onNetwork", { phase: "sale_prop_custom_check", ...check });
  }
  const temporaryPreview = await previewSalePropValues(page, temporary.formValues, state.global);
  const temporaryRows = mergePreviewRows(temporary.formValues.sku, temporaryPreview.rows);
  temporary.formValues.sku = temporaryRows;
  const temporaryState = { ...state, formValues: temporary.formValues };
  assertItemIdentity(temporaryState, baseUrl, task.itemId);
  validateTemporaryPrewrite(temporary.formValues, temporary.formValues, temporary.token);
  await reportPhase("temp_submitting", "已生成临时唯一规格，准备提交以获取新 SKU", "warning", 32);
  await invokeHook("onWriteStart", { phase: "temporary_submit" });
  writeAttempted = true;
  const temporarySubmit = await submitThroughApi(page, temporary.formValues, state.global, baseUrl);
  await invokeHook("onNetwork", { phase: "temporary_submit", path: PUBLISH_PATH, method: "POST", status: temporarySubmit.status, classification: temporarySubmit.classification });
  if (!temporarySubmit.classification.ok) throw Object.assign(new Error(temporarySubmit.classification.message), { code: temporarySubmit.classification.code, businessCode: temporarySubmit.classification.businessCode });
  const oldIds = new Set(originalSummary.oldSkuIds);
  state = await loadReadback(page, baseUrl, temporaryState, "temporary_readback", (candidate) => {
    const summary = summarizeForm(candidate.formValues);
    return summary.skuIds.length === originalSummary.skuCount
      && new Set(summary.skuIds).size === originalSummary.skuCount
      && summary.skuIds.every((skuId) => !oldIds.has(skuId));
  }, hooks.readbackTiming);
  await invokeHook("onReadback", state.readback);
  assertItemIdentity(state, baseUrl, task.itemId);
  const temporaryReadback = summarizeForm(state.formValues);
  const generatedIds = assertExactUniqueSkuIds(temporaryReadback, originalSummary.skuCount, "temporary_readback_mismatch");
  if (generatedIds.some((skuId) => oldIds.has(skuId))) {
    throw Object.assign(new Error("临时提交回读未得到全新的 SKU ID"), { code: "temporary_readback_mismatch", oldSkuIds: [...oldIds], newSkuIds: generatedIds });
  }
  task.oldSkuIds = originalSummary.skuIds;
  task.newSkuIds = generatedIds;
  await invokeHook("onSnapshot", { phase: "temporary", summary: temporaryReadback });
  await reportPhase("temp_verified", `临时提交成功，已回读 ${generatedIds.length} 个新 SKU`, "success", 58);

  const restore = buildRestoreForm(original, state.formValues, temporary.token);
  const restorePreview = await previewSalePropValues(page, restore, state.global);
  const restoreIds = restore.sku.map((row) => positiveSkuId(row.skuId));
  restore.sku = mergePreviewRows(restore.sku, restorePreview.rows).map((row, index) => ({ ...row, skuId: restoreIds[index], skuOldSku: null, sourceSkuId: null }));
  restore.channelOption = channelOption;
  const finalState = { ...state, formValues: restore };
  assertItemIdentity(finalState, baseUrl, task.itemId);
  validateFinalPrewrite(restore, restore, generatedIds);
  await reportPhase("restoring", "正在恢复原规格、价格、库存、商家编码和条码", "info", 72);
  await invokeHook("onWriteStart", { phase: "final_submit" });
  const finalSubmit = await submitThroughApi(page, restore, state.global, baseUrl);
  await invokeHook("onNetwork", { phase: "final_submit", path: PUBLISH_PATH, method: "POST", status: finalSubmit.status, classification: finalSubmit.classification });
  if (!finalSubmit.classification.ok) throw Object.assign(new Error(finalSubmit.classification.message), { code: finalSubmit.classification.code, businessCode: finalSubmit.classification.businessCode });
  const sortedGeneratedIds = [...generatedIds].sort();
  state = await loadReadback(page, baseUrl, finalState, "final_readback", (candidate) => {
    const summary = summarizeForm(candidate.formValues);
    return JSON.stringify([...summary.skuIds].sort()) === JSON.stringify(sortedGeneratedIds)
      && compareSkuRows(original.sku, candidate.formValues.sku, { ignoreStock: true }).equal
      && compareSaleProps(original.saleProp, candidate.formValues.saleProp)
      && normalizeChannelOption(candidate.formValues).value === channelOption.value;
  }, hooks.readbackTiming);
  await invokeHook("onReadback", state.readback);
  assertItemIdentity(state, baseUrl, task.itemId);
  const finalSummary = summarizeForm(state.formValues);
  const finalIds = assertExactUniqueSkuIds(finalSummary, generatedIds.length, "final_id_mismatch");
  if (JSON.stringify([...finalIds].sort()) !== JSON.stringify([...generatedIds].sort())) {
    throw Object.assign(new Error("最终回读 SKU ID 发生变化"), { code: "final_id_mismatch", expected: generatedIds, actual: finalIds });
  }
  const comparison = compareSkuRows(original.sku, state.formValues.sku, { ignoreStock: true });
  if (!comparison.equal) throw Object.assign(new Error(`最终回读字段不一致：${comparison.reason}`), { code: "final_field_mismatch", reason: comparison.reason });
  if (!compareSaleProps(original.saleProp, state.formValues.saleProp)) {
    throw Object.assign(new Error("最终回读销售属性与原快照不一致"), { code: "final_field_mismatch", reason: "saleProp_mismatch" });
  }
  if (normalizeChannelOption(state.formValues).value !== channelOption.value) {
    throw Object.assign(new Error("最终回读销售渠道与原快照不一致"), { code: "final_field_mismatch", reason: "channel_option_mismatch" });
  }
  await invokeHook("onSnapshot", { phase: "after", summary: finalSummary, comparison });
  await reportPhase("final_verifying", "最终回读一致：原规格字段已恢复且 SKU ID 已更新（库存采用平台实时值）", "success", 100);
  const skuMappings = activeRows(original.sku).map((row, index) => ({
    oldSkuId: positiveSkuId(row?.skuId),
    newSkuId: positiveSkuId(generatedIds[index]),
    ...inventoryMappings[index],
  }));
  return { oldSkuIds: originalSummary.skuIds, newSkuIds: finalIds, skuCount: finalSummary.skuCount, detailVariant: originalSummary.detailVariant, comparison, skuMappings, hookErrors };
}
