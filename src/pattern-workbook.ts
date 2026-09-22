import type { Cell, CellFormulaValue, CellSharedFormulaValue, CellValue, Worksheet } from "exceljs";
import { PATTERN_HEADERS, parsePatternRows, type RawPatternRow } from "./pattern-import.ts";
import type { PatternImportPreview } from "./types.ts";

function isFormulaValue(value: CellValue): value is CellFormulaValue | CellSharedFormulaValue {
  return Boolean(value && typeof value === "object" && ("formula" in value || "sharedFormula" in value));
}

function cellValueText(cell: Cell) {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  if (isFormulaValue(value)) {
    const result = value.result;
    return result == null ? "" : String(result).trim();
  }
  if (typeof value === "object" && "richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text || "").join("").trim();
  }
  if (typeof value === "object" && "text" in value) return String(value.text || "").trim();
  return String(cell.text || "").trim();
}

function worksheetHasValues(worksheet: Worksheet) {
  let found = false;
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cellValueText(cell)) found = true;
    });
  });
  return found;
}

function firstNonEmptyRow(worksheet: Worksheet) {
  for (let rowNumber = 1; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    let found = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cellValueText(cell)) found = true;
    });
    if (found) return rowNumber;
  }
  return null;
}

export async function parsePatternWorkbook(contents: ArrayBuffer): Promise<PatternImportPreview> {
  const excelModule = await import("exceljs");
  const excel = ("default" in excelModule ? excelModule.default : excelModule) as typeof import("exceljs");
  const workbook = new excel.Workbook();
  try {
    await workbook.xlsx.load(new Uint8Array(contents) as never);
  } catch {
    return parsePatternRows([], { errors: ["文件不是可读取的 .xlsx 工作簿"] });
  }

  const nonEmptySheets = workbook.worksheets.filter(worksheetHasValues);
  if (!nonEmptySheets.length) return parsePatternRows([], { errors: ["Excel 没有非空工作表"] });
  const worksheet = nonEmptySheets[0];
  const warnings = nonEmptySheets.length > 1
    ? [`仅读取第一个非空工作表“${worksheet.name}”，其余 ${nonEmptySheets.length - 1} 个工作表已忽略`]
    : [];
  const headerRowNumber = firstNonEmptyRow(worksheet);
  if (!headerRowNumber) return parsePatternRows([], { errors: ["Excel 没有表头"] });

  const headerRow = worksheet.getRow(headerRowNumber);
  const positions = new Map<string, number>();
  const duplicateHeaders = new Set<string>();
  for (let column = 1; column <= Math.max(worksheet.actualColumnCount, PATTERN_HEADERS.length); column += 1) {
    const text = cellValueText(headerRow.getCell(column));
    if (!text) continue;
    if (positions.has(text)) duplicateHeaders.add(text);
    else positions.set(text, column);
  }

  const errors: string[] = [];
  const missingHeaders = PATTERN_HEADERS.filter((header) => !positions.has(header));
  if (missingHeaders.length) errors.push(`缺少必填列：${missingHeaders.join("、")}`);
  const repeatedRequiredHeaders = PATTERN_HEADERS.filter((header) => duplicateHeaders.has(header));
  if (repeatedRequiredHeaders.length) errors.push(`表头重复：${repeatedRequiredHeaders.join("、")}`);
  if (errors.length) return parsePatternRows([], { sheetName: worksheet.name, errors, warnings });

  const rawRows: RawPatternRow[] = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values: Record<string, string> = {};
    const formulaColumns: string[] = [];
    const issues: string[] = [];
    let hasValue = false;
    for (const header of PATTERN_HEADERS) {
      const cell = row.getCell(positions.get(header) as number);
      const value = cellValueText(cell);
      values[header] = value;
      if (value) hasValue = true;
      if (isFormulaValue(cell.value)) formulaColumns.push(header);
      if (["商品ID", "商家编码", "条形码"].includes(header)
        && typeof cell.value === "number"
        && Number.isInteger(cell.value)
        && !Number.isSafeInteger(cell.value)) {
        issues.push(`${header}是超出安全范围的数字，请在 Excel 中改为文本`);
      }
      if (cell.value instanceof Date) issues.push(`${header}不能是日期`);
    }
    if (hasValue) rawRows.push({ rowNumber, values, formulaColumns, issues });
  }

  return parsePatternRows(rawRows, { sheetName: worksheet.name, errors, warnings });
}
