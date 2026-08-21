import crypto from "node:crypto";
import fs from "node:fs/promises";
import ExcelJS from "exceljs";

const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
const FIXED_VALUES = { O: "水星", P: "不是", Q: "非电脑类目" };

function text(value) {
  return value == null ? "" : String(value).trim();
}

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if ("result" in value) return text(value.result);
    if ("text" in value) return text(value.text);
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => text(part.text)).join("");
  }
  return text(value);
}

function normalizeId(value) {
  const result = text(value);
  return /^\d+$/.test(result) ? result : null;
}

function mappingKey(mapping) {
  return `${mapping.oldSkuId}:${mapping.newSkuId}`;
}

export function normalizeSkuMappings(mappings) {
  if (!Array.isArray(mappings) || !mappings.length) {
    throw Object.assign(new Error("国补模板缺少旧 SKU 到新 SKU 的映射"), { code: "subsidy_mapping_empty" });
  }
  const normalized = mappings.map((mapping, index) => {
    const oldSkuId = normalizeId(mapping?.oldSkuId);
    const newSkuId = normalizeId(mapping?.newSkuId);
    if (!oldSkuId || !newSkuId) throw Object.assign(new Error(`第 ${index + 1} 条 SKU 映射 ID 无效`), { code: "subsidy_mapping_invalid", index });
    const subMaterialName = text(mapping?.subMaterialName);
    const specification = text(mapping?.specification);
    const barcode = text(mapping?.barcode);
    if (!subMaterialName || !specification) throw Object.assign(new Error(`SKU ${oldSkuId} 缺少国补品名或规格`), { code: "subsidy_mapping_metadata_missing", oldSkuId });
    if (barcode && !/^\d{8,20}$/.test(barcode)) throw Object.assign(new Error(`SKU ${oldSkuId} 的 69 码格式无效`), { code: "subsidy_mapping_barcode_invalid", oldSkuId });
    return { oldSkuId, newSkuId, materialNo: text(mapping?.materialNo), barcode, subMaterialName, specification };
  });
  const keys = new Set(normalized.map(mappingKey));
  if (keys.size !== normalized.length) throw Object.assign(new Error("国补 SKU 映射存在重复项"), { code: "subsidy_mapping_duplicate" });
  return normalized;
}

function buildIndexes(mappings) {
  const byId = new Map();
  for (const mapping of mappings) {
    for (const id of [mapping.oldSkuId, mapping.newSkuId]) {
      const existing = byId.get(id);
      if (existing && (existing.oldSkuId !== mapping.oldSkuId || existing.newSkuId !== mapping.newSkuId)) {
        throw Object.assign(new Error(`SKU ID ${id} 在国补映射中对应多个目标`), { code: "subsidy_mapping_id_ambiguous", skuId: id });
      }
      byId.set(id, mapping);
    }
  }
  return byId;
}

function findRowMapping(row, byId) {
  const matches = new Map();
  for (let column = 1; column <= row.cellCount; column += 1) {
    const id = normalizeId(cellText(row.getCell(column)));
    if (id && byId.has(id)) {
      const mapping = byId.get(id);
      matches.set(mappingKey(mapping), mapping);
    }
  }
  if (matches.size > 1) {
    throw Object.assign(new Error(`国补模板第 ${row.number} 行包含相互冲突的 SKU ID`), { code: "subsidy_template_row_ambiguous", row: row.number });
  }
  if (!matches.size) return null;
  return matches.values().next().value;
}

function applyMapping(row, mapping) {
  const templateBarcode = cellText(row.getCell("E"));
  if (mapping.barcode && templateBarcode !== mapping.barcode) {
    throw Object.assign(new Error(`国补模板第 ${row.number} 行的 69 码与 SKU ${mapping.newSkuId} 不一致`), {
      code: "subsidy_template_barcode_mismatch",
      row: row.number,
      skuId: mapping.newSkuId,
    });
  }
  row.getCell("H").value = mapping.subMaterialName;
  row.getCell("I").value = mapping.specification;
  row.getCell("O").value = FIXED_VALUES.O;
  row.getCell("P").value = FIXED_VALUES.P;
  row.getCell("Q").value = FIXED_VALUES.Q;
}

export async function fillSubsidyWorkbookBuffer(buffer, mappings, { requireAllMappings = true } = {}) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!input.length) throw Object.assign(new Error("国补模板为空"), { code: "subsidy_template_empty" });
  if (input.length > MAX_WORKBOOK_BYTES) throw Object.assign(new Error("国补模板超过大小限制"), { code: "subsidy_template_too_large" });
  const normalized = normalizeSkuMappings(mappings);
  const byId = buildIndexes(normalized);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(input);
  } catch (cause) {
    throw Object.assign(new Error("国补模板不是可读取的 XLSX 文件"), { code: "subsidy_template_invalid", cause });
  }
  let matchedRows = 0;
  const matchedKeys = new Set();
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const mapping = findRowMapping(row, byId);
      if (!mapping) return;
      applyMapping(row, mapping);
      matchedRows += 1;
      matchedKeys.add(mappingKey(mapping));
    });
  }
  if (!matchedRows) throw Object.assign(new Error("国补模板中没有找到可匹配的旧/新 SKU ID"), { code: "subsidy_template_no_rows" });
  if (requireAllMappings) {
    const missing = normalized.filter((mapping) => !matchedKeys.has(mappingKey(mapping)));
    if (missing.length) {
      throw Object.assign(new Error(`国补模板缺少 ${missing.length} 条 SKU 映射行`), { code: "subsidy_template_mapping_incomplete", missing: missing.map((mapping) => mapping.oldSkuId) });
    }
  }
  const output = await workbook.xlsx.writeBuffer();
  const bytes = Buffer.from(output);
  return {
    buffer: bytes,
    matchedRows,
    matchedMappings: matchedKeys.size,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    columns: { ...FIXED_VALUES, H: "sub_material_name", I: "specification" },
  };
}

export async function fillSubsidyWorkbookFile(inputPath, outputPath, mappings, options = {}) {
  const input = await fs.readFile(inputPath);
  const result = await fillSubsidyWorkbookBuffer(input, mappings, options);
  await fs.writeFile(outputPath, result.buffer);
  return { ...result, inputPath, outputPath };
}