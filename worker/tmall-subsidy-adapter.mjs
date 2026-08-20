import fs from "node:fs/promises";
import path from "node:path";
import { fillSubsidyWorkbookFile } from "./subsidy-workbook.mjs";

export const SUBSIDY_URL = "https://myseller.taobao.com/home.htm/gov-subsidy/goods-manage";
const SUCCESS_MARKERS = /提交成功|上传成功|保存成功|操作成功|已生效/;
const AUTH_MARKERS = /登录|重新登录|安全验证|验证码|滑块|风险/;

function text(value) {
  return value == null ? "" : String(value).trim();
}

function error(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

async function visibleCount(locator) {
  try {
    const count = await locator.count();
    let visible = 0;
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
    }
    return visible;
  } catch { return 0; }
}

async function firstVisible(page, selectors, name) {
  for (const selector of selectors) {
    const locator = typeof selector === "string" ? page.locator(selector).first() : selector;
    if (await visibleCount(locator)) return locator;
  }
  throw error(`国补页面找不到${name}`, "subsidy_selector_missing");
}

async function firstPresent(page, selectors, name) {
  for (const selector of selectors) {
    const locator = typeof selector === "string" ? page.locator(selector).first() : selector;
    if (await locator.count().catch(() => 0)) return locator;
  }
  throw error(`国补页面找不到${name}`, "subsidy_selector_missing");
}

async function clickText(page, names, name, scope = page) {
  for (const value of names) {
    const candidates = [
      scope.getByRole?.("button", { name: value, exact: false }),
      scope.getByText?.(value, { exact: false }),
    ].filter(Boolean);
    for (const candidate of candidates) {
      const locator = candidate.first();
      if (await visibleCount(locator)) {
        await locator.click();
        return;
      }
    }
  }
  throw error(`国补页面找不到${name}`, "subsidy_selector_missing");
}

async function bodyText(page) {
  try { return text(await page.locator("body").innerText()); } catch { return ""; }
}

async function assertPageReady(page) {
  const url = text(page.url?.());
  const content = await bodyText(page);
  if (AUTH_MARKERS.test(`${url}\n${content.slice(0, 5000)}`) && !/国补|商品管理|新增/.test(content)) {
    throw error("淘宝国补页面需要人工登录或验证", "subsidy_auth_required");
  }
}

async function fillInput(page, selectors, value, name) {
  const input = await firstVisible(page, selectors, name);
  await input.fill(String(value));
  return input;
}

async function currentDrawer(page) {
  const dialogs = page.locator('[role="dialog"], .next-drawer, .el-dialog, .ant-modal');
  const count = await dialogs.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const locator = dialogs.nth(index);
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return page;
}

async function waitForUploadedFile(scope, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  const selector = '.next-upload-list-item-done, .next-upload-list-item-status-done';
  while (Date.now() < deadline) {
    const done = scope.locator(selector);
    if (await visibleCount(done)) return done.first();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw error("国补模板上传未完成", "subsidy_upload_incomplete");
}

function defaultSelectors() {
  return {
    itemId: [
      'input[placeholder*="商品ID"]',
      'input[placeholder*="商品 ID"]',
      'input[aria-label*="商品ID"]',
      'input[name*="item" i]',
    ],
    replacementIds: [
      'textarea[placeholder*="替换"]',
      'input[placeholder*="替换"]',
      'textarea[aria-label*="替换"]',
      'input[name*="sku" i]',
    ],
    file: ['input[type="file"]'],
  };
}

function selectorsFromEnv() {
  const raw = process.env.TMALL_SUBSIDY_SELECTORS;
  if (!raw) return defaultSelectors();
  try {
    const configured = JSON.parse(raw);
    return { ...defaultSelectors(), ...configured };
  } catch (cause) {
    throw error("TMALL_SUBSIDY_SELECTORS 不是有效 JSON", "subsidy_config_invalid", { cause });
  }
}

export async function executeTmallSubsidy(page, task, skuMappings, hooks = {}, options = {}) {
  if (!page || page.isClosed?.()) throw error("国补页面不可用", "subsidy_page_unavailable");
  if (!Array.isArray(skuMappings) || !skuMappings.length) throw error("国补流程缺少 SKU 映射", "subsidy_mapping_empty");
  const selectors = { ...selectorsFromEnv(), ...(options.selectors || {}) };
  const dataDir = options.dataDir || process.env.TMALL_DATA_DIR || ".runtime/tmall-worker";
  const templateDir = path.join(dataDir, "subsidy");
  await fs.mkdir(templateDir, { recursive: true });
  const inputPath = path.join(templateDir, `${task.id}-template.xlsx`);
  const outputPath = path.join(templateDir, `${task.id}-filled.xlsx`);
  await hooks.onPhase?.({ phase: "subsidy_preparing", progress: 88, level: "info", message: "正在打开淘宝国补商品管理" });
  await page.goto(SUBSIDY_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState?.("networkidle", { timeout: 20_000 }).catch(() => {});
  await assertPageReady(page);
  await clickText(page, ["新增/更新国补商品", "新增/更新", "新增国补商品"], "新增/更新国补商品入口");
  const firstStep = await currentDrawer(page);
  const manualInputOption = firstStep.getByText?.("手动输入商品ID", { exact: true });
  const modernFlow = Boolean(manualInputOption && await visibleCount(manualInputOption));
  let filled;
  let submitScope;
  if (modernFlow) {
    await manualInputOption.click();
    await fillInput(firstStep, ['textarea#itemId'], task.itemId, "商品 ID 输入框");
    await clickText(page, ["下一步"], "下一步按钮", firstStep);
    submitScope = await currentDrawer(page);
    const downloadPromise = page.waitForEvent?.("download");
    await clickText(page, ["下载模板", "下载模版"], "下载模板按钮", submitScope);
    if (!downloadPromise) throw error("国补页面不支持下载事件监听", "subsidy_download_unsupported");
    const download = await downloadPromise;
    await download.saveAs(inputPath);
    filled = await fillSubsidyWorkbookFile(inputPath, outputPath, skuMappings);
    const uploadInput = await firstPresent(submitScope, ["#goodsFile", ...selectors.file], "文件上传控件");
    await uploadInput.setInputFiles(outputPath);
    await waitForUploadedFile(submitScope);
  } else {
    await fillInput(page, selectors.itemId, task.itemId, "商品 ID 输入框");
    await fillInput(page, selectors.replacementIds, skuMappings.map((mapping) => mapping.newSkuId).join(","), "替换成功商品 ID 输入框");
    await clickText(page, ["下一步"], "下一步按钮");
    submitScope = await currentDrawer(page);
    const downloadPromise = page.waitForEvent?.("download");
    await clickText(page, ["下载模板", "下载模版"], "下载模板按钮", submitScope);
    if (!downloadPromise) throw error("国补页面不支持下载事件监听", "subsidy_download_unsupported");
    const download = await downloadPromise;
    await download.saveAs(inputPath);
    filled = await fillSubsidyWorkbookFile(inputPath, outputPath, skuMappings);
    const uploadInput = await firstPresent(page, selectors.file, "文件上传控件");
    await uploadInput.setInputFiles(outputPath);
    await clickText(page, ["上传表格", "上传"], "上传表格按钮");
  }
  await hooks.onPhase?.({ phase: "subsidy_template_ready", progress: 92, level: "info", message: `国补模板已填充 ${filled.matchedRows} 行并上传完成` });
  await hooks.onWriteStart?.({ phase: "subsidy_submit", itemId: String(task.itemId) });
  await clickText(page, ["提交", "确认提交"], "提交按钮", submitScope);
  await page.waitForTimeout?.(1_000);
  const resultText = await bodyText(page);
  if (!SUCCESS_MARKERS.test(resultText)) {
    throw error("国补提交响应无法确认成功", "subsidy_response_unknown");
  }
  await hooks.onPhase?.({ phase: "subsidy_verified", progress: 100, level: "success", message: "国补商品已提交并收到成功提示" });
  return {
    itemId: String(task.itemId),
    inputPath,
    outputPath,
    matchedRows: filled.matchedRows,
    workbookSha256: filled.sha256,
  };
}