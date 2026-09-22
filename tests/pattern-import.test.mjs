import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parsePatternRows } from "../src/pattern-import.ts";
import { parsePatternWorkbook } from "../src/pattern-workbook.ts";

const row = (rowNumber, overrides = {}) => ({
  rowNumber,
  values: {
    商品ID: "819488060800",
    规格: "150cm×210cm",
    颜色分类: "原花型",
    价格: "899",
    数量: "1",
    商家编码: "523673",
    条形码: "6923283207253",
    备注: "原花型不增加新规格",
    ...overrides,
  },
});

test("groups every explicitly listed combination by item ID", () => {
  const preview = parsePatternRows([
    row(2),
    row(3, { 颜色分类: "新花型", 商家编码: "623673", 条形码: "", 备注: "" }),
  ], { sheetName: "Sheet1" });

  assert.equal(preview.valid, true);
  assert.equal(preview.canSubmit, true);
  assert.equal(preview.requestedCount, 2);
  assert.equal(preview.items.length, 1);
  assert.deepEqual(preview.items[0].rows[1], {
    sourceRow: 3,
    specification: "150cm×210cm",
    color: "新花型",
    price: "899.00",
    quantity: 1,
    merchantCode: "623673",
    barcode: "",
    remark: "",
  });
});

test("original-pattern remarks keep rows explicit instead of suppressing them", () => {
  const preview = parsePatternRows([row(2), row(3, { 规格: "200cm×230cm", 商家编码: "523674" })]);
  assert.equal(preview.valid, true);
  assert.equal(preview.canSubmit, true);
  assert.equal(preview.requestedCount, 2);
  assert.match(preview.warnings.join("\n"), /不生成未列出的笛卡尔积/);
});

test("rejects duplicate combinations, duplicate merchant codes, and invalid numeric fields", () => {
  const preview = parsePatternRows([
    row(2, { 颜色分类: "新花型 A", 商家编码: "NEW-1", 备注: "新增" }),
    row(3, { 颜色分类: "新花型 A", 商家编码: "NEW-2", 备注: "新增" }),
    row(4, { 规格: "200cm×230cm", 颜色分类: "新花型 B", 商家编码: "NEW-1", 备注: "新增" }),
    row(5, { 规格: "220cm×240cm", 颜色分类: "新花型 C", 商家编码: "NEW-3", 价格: "0", 数量: "1.5", 备注: "新增" }),
  ]);
  assert.equal(preview.valid, false);
  assert.match(preview.errors.join("\n"), /组合重复/);
  assert.match(preview.errors.join("\n"), /商家编码重复/);
  assert.match(preview.errors.join("\n"), /价格必须/);
  assert.match(preview.errors.join("\n"), /数量必须/);
});

test("reads an xlsx workbook without coercing identifier strings", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("花型");
  worksheet.addRow(["商品ID", "规格", "颜色分类", "价格", "数量", "商家编码", "条形码", "备注"]);
  worksheet.addRow(["819488060800", "150cm×210cm", "新花型", 899, 0, "000523673", "06923283207253", "新增"]);
  const buffer = await workbook.xlsx.writeBuffer();
  const contents = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const preview = await parsePatternWorkbook(contents);
  assert.equal(preview.valid, true);
  assert.equal(preview.sheetName, "花型");
  assert.equal(preview.items[0].itemId, "819488060800");
  assert.equal(preview.items[0].rows[0].merchantCode, "000523673");
  assert.equal(preview.items[0].rows[0].barcode, "06923283207253");
  assert.equal(preview.items[0].rows[0].quantity, 0);
});

test("rejects missing headers and formulas in business cells", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow(["商品ID", "规格", "颜色分类", "价格", "数量", "商家编码", "条形码"]);
  worksheet.addRow(["819488060800", "150cm×210cm", "新花型", { formula: "800+99", result: 899 }, 1, "NEW-1", ""]);
  let buffer = await workbook.xlsx.writeBuffer();
  let contents = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  let preview = await parsePatternWorkbook(contents);
  assert.equal(preview.valid, false);
  assert.match(preview.errors.join("\n"), /缺少必填列：备注/);

  worksheet.getRow(1).getCell(8).value = "备注";
  buffer = await workbook.xlsx.writeBuffer();
  contents = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  preview = await parsePatternWorkbook(contents);
  assert.equal(preview.valid, false);
  assert.match(preview.errors.join("\n"), /包含公式列 价格/);
});
