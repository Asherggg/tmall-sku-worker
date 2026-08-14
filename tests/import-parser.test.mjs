import test from "node:test";
import assert from "node:assert/strict";
import { parseImport } from "../src/import-parser.ts";

test("parses one item ID per line without SKU fields", () => {
  const preview = parseImport("828872681901\r\n\r\n828872681902");
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.items, [
    { itemId: "828872681901", skuIds: [] },
    { itemId: "828872681902", skuIds: [] },
  ]);
  assert.equal(preview.skuCount, 0);
});

test("reports duplicate and invalid item ID lines", () => {
  const preview = parseImport("828872681901\n828872681901\nbad-id");
  assert.equal(preview.valid, false);
  assert.deepEqual(preview.errors, ["第 2 行商品 ID 重复", "第 3 行商品 ID 无效"]);
});

test("keeps the existing CSV format compatible", () => {
  const preview = parseImport("\uFEFFitemId,skuId,expectedSkuCount\n828872681901,5757013487113,2\n828872681901,5757013487114,2");
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.items, [{
    itemId: "828872681901",
    skuIds: ["5757013487113", "5757013487114"],
    expectedSkuCount: 2,
  }]);
  assert.equal(preview.skuCount, 2);
});

test("accepts a one-column itemId CSV", () => {
  const preview = parseImport("itemId\n828872681901");
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.items, [{ itemId: "828872681901", skuIds: [] }]);
});
