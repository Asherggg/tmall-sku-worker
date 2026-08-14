export interface ParsedItemInput {
  itemId: string;
  skuIds: string[];
  expectedSkuCount?: number;
}

export interface ImportParseResult {
  items: ParsedItemInput[];
  valid: boolean;
  errors: string[];
  skuCount: number;
}

const NUMERIC_ID = /^\d+$/;

export function parseImport(text: string): ImportParseResult {
  const errors: string[] = [];
  const rows = text
    .split(/\r?\n/)
    .map((row, index) => (index === 0 ? row.replace(/^\uFEFF/, "") : row).trim())
    .filter(Boolean);

  if (!rows.length) {
    return { items: [], valid: false, errors: ["请输入商品 ID"], skuCount: 0 };
  }

  const firstValues = rows[0].split(",").map((value) => value.trim());
  const csvMode = rows[0].includes(",") || firstValues.includes("itemId");
  if (!csvMode) return parseItemIdLines(rows);

  const itemIndex = firstValues.indexOf("itemId");
  const skuIndex = firstValues.indexOf("skuId");
  const expectedIndex = firstValues.indexOf("expectedSkuCount");
  if (itemIndex < 0) return { items: [], valid: false, errors: ["缺少必填列 itemId"], skuCount: 0 };

  const map = new Map<string, ParsedItemInput>();
  const seen = new Set<string>();
  rows.slice(1).forEach((row, index) => {
    const values = row.split(",").map((value) => value.trim());
    const line = index + 2;
    const itemId = values[itemIndex] || "";
    const skuId = skuIndex >= 0 ? values[skuIndex] || "" : "";
    if (!NUMERIC_ID.test(itemId)) errors.push(`第 ${line} 行 itemId 无效`);
    if (skuId && !NUMERIC_ID.test(skuId)) errors.push(`第 ${line} 行 skuId 无效`);
    const key = `${itemId}:${skuId}`;
    if (seen.has(key)) errors.push(`第 ${line} 行重复`);
    seen.add(key);
    if (!NUMERIC_ID.test(itemId)) return;

    const current = map.get(itemId) || { itemId, skuIds: [] };
    if (skuId && NUMERIC_ID.test(skuId)) current.skuIds.push(skuId);
    if (expectedIndex >= 0 && values[expectedIndex]) {
      const expected = Number(values[expectedIndex]);
      if (!Number.isInteger(expected) || expected < 1) errors.push(`第 ${line} 行 expectedSkuCount 无效`);
      else if (current.expectedSkuCount != null && current.expectedSkuCount !== expected) errors.push(`第 ${line} 行 expectedSkuCount 与同商品其他行不一致`);
      else current.expectedSkuCount = expected;
    }
    map.set(itemId, current);
  });

  const items = [...map.values()];
  for (const item of items) {
    if (item.skuIds.length && item.expectedSkuCount != null && item.skuIds.length !== item.expectedSkuCount) {
      errors.push(`商品 ${item.itemId} 的 SKU 数与 expectedSkuCount 不一致`);
    }
  }
  return result(items, errors);
}

function parseItemIdLines(rows: string[]): ImportParseResult {
  const errors: string[] = [];
  const items: ParsedItemInput[] = [];
  const seen = new Set<string>();

  rows.forEach((itemId, index) => {
    const line = index + 1;
    if (!NUMERIC_ID.test(itemId)) {
      errors.push(`第 ${line} 行商品 ID 无效`);
      return;
    }
    if (seen.has(itemId)) {
      errors.push(`第 ${line} 行商品 ID 重复`);
      return;
    }
    seen.add(itemId);
    items.push({ itemId, skuIds: [] });
  });

  return result(items, errors);
}

function result(items: ParsedItemInput[], errors: string[]): ImportParseResult {
  if (!items.length && !errors.length) errors.push("未找到有效商品 ID");
  return {
    items,
    valid: errors.length === 0 && items.length > 0,
    errors,
    skuCount: items.reduce((sum, item) => sum + item.skuIds.length, 0),
  };
}
