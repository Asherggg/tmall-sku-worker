import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  SUBSIDY_FILE_CONFIG_API,
  SUBSIDY_FILE_OPERATOR_API,
  SUBSIDY_ITEM_QUERY_API,
  callSubsidyMtop,
  executeTmallSubsidyApi,
  importSubsidyFileApi,
  querySubsidyItemsApi,
  uploadSubsidyFileApi,
  waitForSubsidyReadbackApi,
} from "../worker/subsidy-api-adapter.mjs";

function response(url, status, payload, body) {
  const value = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    url: () => url,
    status: () => status,
    text: async () => value,
    body: async () => body ?? Buffer.from(value),
  };
}

function mtopResponse(url, payload, status = 200) {
  const callback = new URL(url).searchParams.get("callback");
  return response(url, status, callback ? `${callback}(${JSON.stringify(payload)})` : payload);
}

function requestData(url, init = {}) {
  const parsed = new URL(url);
  const raw = parsed.searchParams.get("data") || new URLSearchParams(init.data || "").get("data");
  return raw ? JSON.parse(raw) : {};
}

function mockPage(fetchImpl, token = "mock-token") {
  const context = {
    cookies: async () => [{ name: "_m_h5_tk", value: `${token}_9999999999999` }],
    request: { fetch: fetchImpl },
  };
  return { isClosed: () => false, context: () => context };
}

function success(data = {}) {
  return { data, ret: ["SUCCESS::调用成功"], traceId: "mock-trace" };
}

const mapping = {
  oldSkuId: "6127544904013",
  newSkuId: "6292306294634",
  materialNo: "562245",
  barcode: "6942730734999",
  subMaterialName: "素境织眠国民加厚对枕套(沙色)",
  specification: "48cm×74cm",
};

test("subsidy MTop signs GET data and emits only a redacted audit shape", async () => {
  const calls = [];
  const network = [];
  const page = mockPage(async (url, init) => {
    calls.push({ url, init });
    return mtopResponse(url, success({ resultData: { ok: true } }));
  });

  const result = await callSubsidyMtop(page, SUBSIDY_ITEM_QUERY_API, { pageNo: 1 }, { onNetwork: (entry) => network.push(entry) });
  assert.equal(result.payload.data.resultData.ok, true);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  const data = url.searchParams.get("data");
  const expectedSign = crypto.createHash("md5").update(`mock-token&${url.searchParams.get("t")}&12574478&${data}`).digest("hex");
  assert.equal(url.searchParams.get("sign"), expectedSign);
  assert.equal(url.searchParams.get("api"), SUBSIDY_ITEM_QUERY_API);
  assert.deepEqual(JSON.parse(data), { pageNo: 1 });
  assert.deepEqual(network, [{
    phase: "subsidy_api",
    api: SUBSIDY_ITEM_QUERY_API,
    method: "GET",
    status: 200,
    path: `/h5/${SUBSIDY_ITEM_QUERY_API}/1.0/`,
    businessCode: "SUCCESS",
  }]);
  assert.doesNotMatch(JSON.stringify(network), /mock-token|sign/i);
});

test("subsidy IMPORT is POSTed once and never retried after a token failure", async () => {
  let calls = 0;
  const page = mockPage(async (url, init) => {
    calls += 1;
    assert.equal(init.method, "POST");
    assert.deepEqual(requestData(url, init), {
      taskType: "SUBSIDY_GOODS_POOL_UPLOAD",
      bizType: "SUBSIDY_GOODS_POOL_UPLOAD",
      key: "SUBSIDY_GOODS_POOL_FILE/mock.xlsx",
      fileName: "mock.xlsx",
      action: "IMPORT",
    });
    return mtopResponse(url, { data: {}, ret: ["FAIL_SYS_TOKEN_EXOIRED::令牌过期"] });
  });

  await assert.rejects(
    importSubsidyFileApi(page, { key: "SUBSIDY_GOODS_POOL_FILE/mock.xlsx", fileName: "mock.xlsx" }),
    (error) => error.code === "subsidy_auth_required",
  );
  assert.equal(calls, 1);
});

test("subsidy upload rejects an OSS lookalike host", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subsidy-upload-host-"));
  const file = path.join(dir, "mock.xlsx");
  await fs.writeFile(file, "mock");
  let calls = 0;
  const page = mockPage(async (url) => {
    calls += 1;
    return mtopResponse(url, success({ resultData: {
      host: "aliyuncs.com.evil.test",
      key: "SUBSIDY_GOODS_POOL_FILE/mock.xlsx",
      policy: "mock-policy",
      signature: "mock-signature",
      accessKeyId: "mock-key",
    } }));
  });
  try {
    await assert.rejects(uploadSubsidyFileApi(page, file, "mock.xlsx"), (error) => error.code === "subsidy_upload_config_invalid");
    assert.equal(calls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("subsidy API dry-run exports, fills, and uploads without IMPORT", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("file");
  sheet.addRow(["商品ID", "商品名称", "SKU ID", "IMEI", "69码", "链接", "能效", "型号", "规格", "名称", "中心型号", "中心名称", "外机码", "外机型号", "品牌", "AI", "类型"]);
  sheet.addRow(["1061776009736", "商品", mapping.newSkuId, "", mapping.barcode]);
  const template = Buffer.from(await workbook.xlsx.writeBuffer());
  const operations = [];
  const page = mockPage(async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "h5api.m.taobao.com") {
      const data = requestData(url, init);
      operations.push(data.action || parsed.searchParams.get("api"));
      if (data.action === "EXPORT") return mtopResponse(url, success({ resultData: { taskId: "mock-export" } }));
      if (data.action === "QUERY_PROGRESS") {
        return mtopResponse(url, success({ resultData: { taskStatus: "FINISHED", url: "https://crpfile.oss-cn-zhangjiakou.aliyuncs.com/gei/mock.xlsx" } }));
      }
      if (parsed.searchParams.get("api") === SUBSIDY_FILE_CONFIG_API) {
        return mtopResponse(url, success({ resultData: {
          host: "crpfile.oss-cn-zhangjiakou.aliyuncs.com",
          key: "SUBSIDY_GOODS_POOL_FILE/mock.xlsx",
          policy: "mock-policy",
          signature: "mock-signature",
          accessKeyId: "mock-key",
        } }));
      }
      throw new Error(`unexpected MTop operation ${JSON.stringify(data)}`);
    }
    if (parsed.pathname === "/gei/mock.xlsx") return response(url, 200, "", template);
    if (parsed.hostname === "crpfile.oss-cn-zhangjiakou.aliyuncs.com" && init.multipart) {
      operations.push("OSS_UPLOAD");
      return response(url, 200, "");
    }
    throw new Error(`unexpected URL ${url}`);
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subsidy-api-dry-run-"));
  let writeStarts = 0;
  try {
    const result = await executeTmallSubsidyApi(page, { id: "dry-run", itemId: "1061776009736" }, [mapping], {
      onWriteStart: () => { writeStarts += 1; },
    }, { dataDir: dir, dryRun: true, timeoutMs: 100 });
    assert.equal(result.dryRun, true);
    assert.equal(result.matchedRows, 1);
    assert.equal(result.uploadStatus, 200);
    assert.equal(writeStarts, 0);
    assert.deepEqual(operations, ["EXPORT", "QUERY_PROGRESS", SUBSIDY_FILE_CONFIG_API, "OSS_UPLOAD"]);
    assert.equal(operations.includes("IMPORT"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("subsidy item query paginates when the API ignores the requested page size", async () => {
  const requestedPages = [];
  const page = mockPage(async (url, init) => {
    const { pageNo } = requestData(url, init);
    requestedPages.push(pageNo);
    const count = pageNo === 1 ? 25 : pageNo === 2 ? 5 : 0;
    const rows = Array.from({ length: count }, (_, index) => ({
      itemId: "1061776009736",
      skuId: String(pageNo * 100 + index),
    }));
    return mtopResponse(url, success(rows));
  });
  const rows = await querySubsidyItemsApi(page, "1061776009736", { pageSize: 100 });
  assert.equal(rows.length, 30);
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

test("subsidy readback verifies SKU, barcode, product name, and specification", async () => {
  const row = {
    itemId: "1061776009736",
    skuId: mapping.newSkuId,
    barcode: mapping.barcode,
    zfbtModel: mapping.subMaterialName,
    modelDesc: mapping.specification,
  };
  const page = mockPage(async (url) => mtopResponse(url, success([row])));
  const readbacks = [];
  const result = await waitForSubsidyReadbackApi(page, row.itemId, [mapping], {
    timeoutMs: 0,
    onReadback: (entry) => readbacks.push(entry),
  });
  assert.equal(result.verified, true);
  assert.equal(result.rows.length, 1);
  assert.equal(readbacks[0].rowCount, 1);

  const mismatchPage = mockPage(async (url) => mtopResponse(url, success([{ ...row, modelDesc: "错误规格" }])));
  await assert.rejects(
    waitForSubsidyReadbackApi(mismatchPage, row.itemId, [mapping], { timeoutMs: 0 }),
    (error) => error.code === "subsidy_readback_mismatch",
  );
});
