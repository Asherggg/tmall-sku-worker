import type {
  AddPatternItemInput,
  PatternImportPreview,
  PatternImportRow,
  PatternSkuInput,
} from "./types.ts";

export const PATTERN_HEADERS = ["商品ID", "规格", "颜色分类", "价格", "数量", "商家编码", "条形码", "备注"] as const;
export const REFERENCE_REMARK = "原花型不增加新规格";

export interface RawPatternRow {
  rowNumber: number;
  values: Record<string, string>;
  formulaColumns?: string[];
  issues?: string[];
}

const ITEM_ID = /^\d+$/;
const NON_NEGATIVE_INTEGER = /^\d+$/;
const PRICE = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;

function valueOf(row: RawPatternRow, header: (typeof PATTERN_HEADERS)[number]) {
  return String(row.values[header] ?? "").trim();
}

export function normalizePatternPrice(value: string) {
  const trimmed = String(value ?? "").trim();
  if (!PRICE.test(trimmed) || Number(trimmed) <= 0) return null;
  const [integer, decimal = ""] = trimmed.split(".");
  return `${integer}.${decimal.padEnd(2, "0")}`;
}

export function isReferencePatternRemark(remark: string) {
  return String(remark || "").includes("原花型");
}

export function parsePatternRows(
  rawRows: RawPatternRow[],
  options: { sheetName?: string; errors?: string[]; warnings?: string[] } = {},
): PatternImportPreview {
  const errors = [...(options.errors || [])];
  const warnings = [...(options.warnings || [])];
  const rows: PatternImportRow[] = [];
  const groups = new Map<string, AddPatternItemInput>();
  const combinations = new Map<string, number>();
  const merchantCodes = new Map<string, number>();

  if (rawRows.length > 500) errors.push(`数据行 ${rawRows.length} 条，超过单次 500 条上限`);

  for (const raw of rawRows.slice(0, 500)) {
    const itemId = valueOf(raw, "商品ID");
    const specification = valueOf(raw, "规格");
    const color = valueOf(raw, "颜色分类");
    const priceText = valueOf(raw, "价格");
    const quantityText = valueOf(raw, "数量");
    const merchantCode = valueOf(raw, "商家编码");
    const barcode = valueOf(raw, "条形码");
    const remark = valueOf(raw, "备注");
    const rowErrors: string[] = [...(raw.issues || [])];

    if (raw.formulaColumns?.length) rowErrors.push(`包含公式列 ${raw.formulaColumns.join("、")}`);
    if (!ITEM_ID.test(itemId)) rowErrors.push("商品ID必须是数字字符串");
    if (!specification) rowErrors.push("规格不能为空");
    else if (specification.length > 200) rowErrors.push("规格超过 200 个字符");
    if (!color) rowErrors.push("颜色分类不能为空");
    else if (color.length > 200) rowErrors.push("颜色分类超过 200 个字符");
    const price = normalizePatternPrice(priceText);
    if (!price) rowErrors.push("价格必须是大于 0 且最多两位小数的数值");
    if (!NON_NEGATIVE_INTEGER.test(quantityText) || Number(quantityText) > 999_999_999) rowErrors.push("数量必须是 0 到 999999999 的整数");
    if (merchantCode.length > 64) rowErrors.push("商家编码超过 64 个字符");
    if (barcode.length > 64) rowErrors.push("条形码超过 64 个字符");

    if (rowErrors.length) {
      errors.push(`第 ${raw.rowNumber} 行：${rowErrors.join("；")}`);
      continue;
    }

    const combinationKey = `${itemId}\u0000${specification}\u0000${color}`;
    const duplicateRow = combinations.get(combinationKey);
    if (duplicateRow) {
      errors.push(`第 ${raw.rowNumber} 行：规格与颜色分类组合重复（首次在第 ${duplicateRow} 行）`);
      continue;
    }
    combinations.set(combinationKey, raw.rowNumber);

    if (merchantCode) {
      const merchantKey = `${itemId}\u0000${merchantCode}`;
      const duplicateMerchantRow = merchantCodes.get(merchantKey);
      if (duplicateMerchantRow) {
        errors.push(`第 ${raw.rowNumber} 行：商家编码重复（首次在第 ${duplicateMerchantRow} 行）`);
        continue;
      }
      merchantCodes.set(merchantKey, raw.rowNumber);
    }

    const sku: PatternSkuInput = {
      sourceRow: raw.rowNumber,
      specification,
      color,
      price: price as string,
      quantity: Number(quantityText),
      merchantCode,
      barcode,
      remark,
    };
    rows.push({ itemId, ...sku });
    const group = groups.get(itemId) || { itemId, rows: [] };
    group.rows.push(sku);
    groups.set(itemId, group);
  }

  const items = [...groups.values()];
  if (!rawRows.length && !errors.length) errors.push("工作表没有数据行");
  if (!items.length && !errors.length) errors.push("没有可识别的商品数据");
  if (rows.some((entry) => isReferencePatternRemark(entry.remark))) {
    warnings.push("含“原花型不增加新规格”备注：仅处理 Excel 明确列出的组合，不生成未列出的笛卡尔积");
  }

  const valid = errors.length === 0 && items.length > 0;
  return {
    items,
    rows,
    valid,
    canSubmit: valid && rows.length > 0,
    errors,
    warnings,
    sheetName: options.sheetName || "",
    requestedCount: rows.length,
  };
}
