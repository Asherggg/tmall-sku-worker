import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  buildInventoryLookupSql,
  createInventoryRepository,
  groupInventoryRows,
  inventoryHealth,
  resolveSkuInventory,
} from "../worker/inventory-service.mjs";
import {
  buildOmsQueryBody,
  classifyOmsResponse,
  executeOmsDisable,
  extractPlatformGoodsRecords,
} from "../worker/oms-platform-adapter.mjs";
import { fillSubsidyWorkbookBuffer } from "../worker/subsidy-workbook.mjs";

function response(url, status, payload) {
  return { url: () => url, status: () => status, text: async () => typeof payload === "string" ? payload : JSON.stringify(payload) };
}

class MockOmsPage {
  constructor() {
    this.records = [
      { id: "9001", baseImc09: "828872681901", baseImc13: "20001", baseImc39: 1, baseImc01: "TMALL" },
      { id: "9002", baseImc09: "828872681901", baseImc13: "20002", baseImc39: 0, baseImc01: "TMALL" },
    ];
    this.calls = [];
  }

  isClosed() { return false; }
  url() { return "https://oms.shuixing.com/#/platformCommodity"; }
  context() {
    return {
      storageState: async () => ({ origins: [{ origin: "https://oms.shuixing.com", localStorage: [{ name: "token", value: "mock-oms-token" }] }] }),
      request: { fetch: async (url, init) => {
      const body = JSON.parse(init.data);
      assert.equal(init.headers["Cas-Auth-Token"], "mock-oms-token");
      this.calls.push({ url, body });
      if (url.endsWith("/queryPage")) return response(url, 200, { code: 200, data: { records: this.records, total: this.records.length } });
      if (url.endsWith("/enable")) {
        for (const id of body.idList) {
          const record = this.records.find((entry) => entry.id === id);
          if (record) record.baseImc39 = 0;
        }
        return response(url, 200, { code: 200, msg: "成功" });
      }
      throw new Error(`unexpected URL ${url}`);
    } },
    };
  }
}

test("Doris lookup SQL uses a fixed table and escaped material values", () => {
  const sql = buildInventoryLookupSql({ materialNos: ["100001", "100001", "100003"] });
  assert.match(sql, /^SELECT total_material_no/);
  assert.match(sql, /guanyuan_back\.ecommerce_sales_inventory_daily_report/);
  assert.match(sql, /'100001', '100003'/);
  assert.throws(() => buildInventoryLookupSql({ materialNos: [] }), (error) => error.code === "inventory_materials_empty");
});

test("runtime config file supplies the token for the fixed inventory API", async () => {
  const previous = Object.fromEntries([
    "TMALL_RUNTIME_CONFIG",
    "INVENTORY_API_BASE_URL",
    "INVENTORY_API_PATH",
    "INVENTORY_API_TOKEN",
    "INVENTORY_API_ALLOW_INSECURE_HTTP",
  ].map((name) => [name, process.env[name]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmall-runtime-config-"));
  const configPath = path.join(dir, "runtime-config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    INVENTORY_API_BASE_URL: "https://ignored.example.test",
    INVENTORY_API_PATH: "/ignored",
    INVENTORY_API_TOKEN: "test-token",
    INVENTORY_API_ALLOW_INSECURE_HTTP: "false",
  })}\n`, "utf8");
  for (const name of Object.keys(previous)) delete process.env[name];
  process.env.TMALL_RUNTIME_CONFIG = configPath;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "http://10.21.16.213:9031/v1/materials/lookup");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    return new Response(JSON.stringify({ materialNo: "100047", barcode: "6944007300463", subMaterialName: "测试品", specification: "48cm×74cm" }), { status: 200 });
  };
  try {
    const repository = createInventoryRepository();
    assert.equal(inventoryHealth().mode, "remote_api");
    assert.equal(inventoryHealth().apiUrl, "http://10.21.16.213:9031/v1/materials/lookup");
    assert.deepEqual(await repository.lookup(["100047"]), [{
      total_material_no: "100047",
      barcode: "6944007300463",
      sub_material_name: "测试品",
      specification: "48cm×74cm",
      updated_at: null,
    }]);
    await repository.close();
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote inventory API accepts a single camelCase record with barcode", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://inventory.example.test/v1/materials/lookup");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(init.body), { materialNos: ["100047"] });
    return new Response(JSON.stringify({
      materialNo: "100047",
      barcode: "6944007300463",
      subMaterialName: "昕柔提花枕套",
      specification: "48cm×74cm",
      updatedAt: "2026-08-19T09:12:32Z",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal(inventoryHealth({ apiBaseUrl: "https://inventory.example.test", apiToken: "test-token" }).mode, "remote_api");
    assert.equal(inventoryHealth({ apiBaseUrl: "http://10.21.16.213:9031", apiToken: "test-token" }).configured, false);
    assert.equal(inventoryHealth({ apiBaseUrl: "http://10.21.16.213:9031", apiToken: "test-token", allowInsecureHttp: true }).mode, "remote_api");
    const repository = createInventoryRepository({ apiBaseUrl: "https://inventory.example.test", apiToken: "test-token" });
    assert.deepEqual(await repository.lookup(["100047"]), [{
      total_material_no: "100047",
      barcode: "6944007300463",
      sub_material_name: "昕柔提花枕套",
      specification: "48cm×74cm",
      updated_at: "2026-08-19T09:12:32Z",
    }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Doris rows fail closed when one material maps to conflicting records", () => {
  const result = groupInventoryRows([
    { total_material_no: "100001", barcode: "6927602628262", sub_material_name: "A", specification: "S" },
    { total_material_no: "100001", barcode: "6927602628263", sub_material_name: "A", specification: "S" },
  ], ["100001"]);
  assert.equal(result[0].status, "ambiguous");
});

test("SKU inventory resolution enriches empty barcodes and subsidy metadata", async () => {
  const result = await resolveSkuInventory([
    { skuId: "1", skuOuterId: "100001", skuBarcode: "" },
    { skuId: "2", skuOuterId: "100003", skuBarcode: "6944007300029" },
  ], { lookup: async () => [
    { total_material_no: "100001", barcode: "6927602628262", sub_material_name: "昕柔全棉枕套", specification: "48cm×74cm" },
    { total_material_no: "100003", barcode: "6944007300029", sub_material_name: "叶韵(驼色)", specification: "220cm×240cm" },
  ] }, { requireBarcode: true });
  assert.equal(result.rows[0].barcode, "6927602628262");
  assert.equal(result.rows[1].subMaterialName, "叶韵(驼色)");
});

test("OMS adapter disables only matching enabled records and reads them back", async () => {
  const page = new MockOmsPage();
  const phases = [];
  const result = await executeOmsDisable(page, "828872681901", {
    onPhase: (entry) => phases.push(entry.phase),
  });
  assert.equal(result.recordCount, 2);
  assert.deepEqual(result.changedRecordIds, ["9001"]);
  assert.equal(page.records.every((record) => record.baseImc39 === 0), true);
  assert.ok(phases.includes("oms_disabled"));
  const toggle = page.calls.find((call) => call.url.endsWith("/enable"));
  assert.deepEqual(toggle.body, { idList: ["9001"] });
});

test("OMS response classification treats CAS redirects as auth-required", () => {
  const result = classifyOmsResponse(200, "https://gateway.shuixing.com/oms-system/", "<html>CAS login</html>");
  assert.equal(result.code, "oms_auth_required");
  assert.deepEqual(buildOmsQueryBody("828872681901", 2, 50, true), {
    baseImc09: "828872681901", pageNum: 2, pageSize: 50, baseImc39: "1", baseImc15: "onsale",
  });
  assert.equal(extractPlatformGoodsRecords({ code: 200, data: { records: [{ id: "1", baseImc09: "828872681901", baseImc13: "20001", baseImc39: 0 }] } }, "828872681901")[0].enabled, false);
});

test("subsidy workbook fills H/I/O/P/Q for every mapped SKU row", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("template");
  sheet.addRow(["旧规格ID", "新规格ID", "", "", "", "", "", "H", "I", "", "", "", "", "", "O", "P", "Q"]);
  sheet.addRow(["5757013487113", "6125801697539"]);
  sheet.addRow(["5757013487114", "6125801697540"]);
  const input = Buffer.from(await workbook.xlsx.writeBuffer());
  const result = await fillSubsidyWorkbookBuffer(input, [
    { oldSkuId: "5757013487113", newSkuId: "6125801697539", materialNo: "100001", subMaterialName: "品名一", specification: "规格一" },
    { oldSkuId: "5757013487114", newSkuId: "6125801697540", materialNo: "100003", subMaterialName: "品名二", specification: "规格二" },
  ]);
  const output = new ExcelJS.Workbook();
  await output.xlsx.load(result.buffer);
  const rows = output.worksheets[0].getRows(2, 2);
  assert.deepEqual(rows.map((row) => [row.getCell(8).value, row.getCell(9).value, row.getCell(15).value, row.getCell(16).value, row.getCell(17).value]), [
    ["品名一", "规格一", "水星", "不是", "非电脑类目"],
    ["品名二", "规格二", "水星", "不是", "非电脑类目"],
  ]);
});
