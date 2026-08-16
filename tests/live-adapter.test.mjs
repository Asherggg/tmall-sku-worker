import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSubmitBody,
  classifySubmitResponse,
  compareSkuRows,
  executeTmallRebuild,
  extractServerFormFromHtml,
  mergeServerForm,
  normalizeChannelOption,
  summarizeForm,
} from "../worker/tmall-live-adapter.mjs";

const ITEM_ID = "828872681901";
const clone = (value) => JSON.parse(JSON.stringify(value));

const sku = (id, overrides = {}) => ({
  skuId: id,
  skuPrice: "2388.00",
  skuStock: 0,
  skuOuterId: "134460",
  skuBarcode: "6942399076300",
  skuHolding: "20",
  skuTitle: "云影微澜 1.5米床",
  skuPicture: { url: "https://img.example.test/sku.jpg" },
  skuQuality: { value: "mainSku", text: "单品", prefilled: true },
  skuCustomize: { value: false, text: "否" },
  skuStatus: "normal",
  status: "normal",
  disabled: false,
  action: { selected: true },
  props: [
    { name: "p-5569827", value: "-1001", text: "1.5米床" },
    { name: "p-1627207", value: "-141098088", text: "云影微澜", img: "color-a.jpg", pix: "color-a-pix.jpg" },
  ],
  ...overrides,
});

function makeForm(itemId = ITEM_ID) {
  const first = sku("5757013487113");
  const second = sku("5757013487114", {
    skuOuterId: "134461",
    skuBarcode: "6942399076301",
    skuTitle: "暮山紫 1.5米床",
    skuPicture: { url: "https://img.example.test/sku-2.jpg" },
    props: [
      { name: "p-5569827", value: "-1001", text: "1.5米床" },
      { name: "p-1627207", value: "-141098089", text: "暮山紫", img: "color-b.jpg", pix: "color-b-pix.jpg" },
    ],
  });
  return {
    id: itemId,
    icmp_global: { id: itemId },
    channelOption: { value: "2" },
    saleProp: {
      "p-5569827": [{ value: -1001, text: "1.5米床" }],
      "p-1627207": [
        { value: -141098088, text: "云影微澜", img: "color-a.jpg", pix: "color-a-pix.jpg" },
        { value: -141098089, text: "暮山紫", img: "color-b.jpg", pix: "color-b-pix.jpg" },
      ],
    },
    sku: [first, second],
    oldsku: [{ skuId: first.skuId }, { skuId: second.skuId }],
  };
}

function salePropKey(props) {
  return props.map((prop) => `${String(prop.name).replace(/^p-/, "")}--${String(prop.value).replace(/^-/, "")}`).sort().join("_");
}

function defaultSalePropMeta() {
  return {
    "p-5569827": {
      name: "p-5569827", label: "适用床尺寸", uiType: "comboboxSaleProps", required: true,
      maxCustomItems: 9999, maxLength: 100, dataSource: [{ value: 32005284901, text: "1.5米床" }],
    },
    "p-1627207": {
      name: "p-1627207", label: "颜色分类", uiType: "newColorSelect", required: false,
      hasCustomProp: true, maxCustomItems: 30, maxLength: 130,
      checkUrl: "asyncOpt.htm?optType=tmall_new_check_custom_color",
    },
  };
}

function bootstrapHtml(form, salePropMeta = defaultSalePropMeta(), globalItemId = form.id) {
  const global = {
    value: {
      id: globalItemId,
      catId: "50000001",
      brand: { brandId: "600001" },
      spuApply: "700001",
      gpfRenderTrace: "mock-render-trace",
      isLightCombine: null,
      isSetsCombine: null,
      combineToNormal: null,
      tmSpuPublishType: null,
      isUnBondedGift: null,
      spu_qf_param: null,
    },
    id: globalItemId,
    globalExtendInfo: "{\"mock\":true}",
  };
  const payload = {
    components: { saleProp: { props: { subItems: salePropMeta } } },
    models: { formValues: form, global },
  };
  return `<html><script>window.Json = ${JSON.stringify(payload)}; window.noIcmpJson = {};</script></html>`;
}

class MockTmallPage {
  constructor(form = makeForm(), options = {}) {
    this.serverForm = clone(form);
    this.pageForm = clone(form);
    this.options = options;
    this.globalItemId = options.globalItemId || form.id;
    this.salePropMeta = clone(options.salePropMeta || defaultSalePropMeta());
    this._url = "about:blank";
    this.submitCount = 0;
    this.getCount = 0;
    this.apiCalls = [];
    this.gotoCalls = [];
    this.waitForUrlCalls = 0;
    this.reloadCalls = 0;
    this.submittedForms = [];
  }

  isClosed() { return false; }
  url() { return this._url; }

  context() {
    return {
      cookies: async () => [{ name: "XSRF-TOKEN", value: "mock-xsrf" }],
      request: { fetch: (url, init) => this.#apiFetch(url, init) },
    };
  }

  async goto(url) {
    this.gotoCalls.push(url);
    throw new Error("pure API adapter must not navigate the page");
  }

  async reload() {
    this.reloadCalls += 1;
    throw new Error("pure API adapter must not reload the page");
  }

  async waitForTimeout() {}

  async waitForURL() {
    this.waitForUrlCalls += 1;
    throw new Error("pure API adapter must not wait for page navigation");
  }

  waitForResponse() {
    throw new Error("pure API adapter must not observe page requests");
  }

  async evaluate() {
    throw new Error("pure API adapter must not evaluate page code");
  }

  #response(url, status, body) {
    return { url: () => url, status: () => status, text: async () => body };
  }

  async #apiFetch(url, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    this.apiCalls.push({ url, method, headers: clone(init.headers || {}), body: init.data || "" });
    const parsedUrl = new URL(url);
    if (method === "GET" && parsedUrl.pathname === "/tmall/publish.htm") {
      this.getCount += 1;
      let html = bootstrapHtml(this.serverForm, this.salePropMeta, this.globalItemId);
      if (this.submitCount > 0 && this.options.fastReadbackHtml) {
        html = typeof this.options.fastReadbackHtml === "function"
          ? this.options.fastReadbackHtml(this.serverForm, this.salePropMeta, this.globalItemId)
          : this.options.fastReadbackHtml;
      }
      return this.#response(url, 200, html);
    }
    if (method === "POST" && parsedUrl.pathname === "/tmall/asyncOpt.htm") return this.#previewResponse(init, url);
    if (method === "POST" && parsedUrl.pathname === "/tmall/submit.htm") {
      const body = new URLSearchParams(init.data);
      return this.#submit(JSON.parse(body.get("jsonBody")), url);
    }
    throw new Error(`unexpected API request: ${method} ${url}`);
  }

  #previewResponse(init, url) {
    const values = JSON.parse(new URLSearchParams(init.data).get("jsonBody"));
    let rows = values.sku.map((row) => ({
      salePropKey: salePropKey(row.props),
      skuId: 0,
      skuPicture: null,
      skuTitle: null,
      skuQuality: { value: "mainSku", text: "单品", prefilled: true },
    })).reverse();
    if (this.options.previewRows) rows = this.options.previewRows(rows, values);
    return this.#response(url, 200, JSON.stringify({ success: true, data: { value: rows } }));
  }

  #submit(submitted, url) {
    this.submitCount += 1;
    this.submittedForms.push(clone(submitted));
    let savedRows = clone(submitted.sku);
    if (this.submitCount === 1) {
      const ids = this.options.temporaryIds || ["6125801697539", "6125801697540"];
      savedRows = savedRows.map((row, index) => ({ ...row, skuId: ids[index] }));
    }
    this.serverForm = { ...clone(submitted), sku: savedRows.reverse() };
    const responseBody = JSON.stringify({
      models: { globalMessage: { type: "success", successUrl: `https://sell.publish.tmall.com/tmall/success.htm?id=${ITEM_ID}&phase=${this.submitCount}` } },
    });
    return this.#response(url, 200, responseBody);
  }
}

function task(overrides = {}) {
  return {
    id: "task-1",
    itemId: ITEM_ID,
    expectedSkuCount: 2,
    skuIds: ["5757013487113", "5757013487114"],
    ...overrides,
  };
}

test("channel option preserves the live page value and ignores environment overrides", () => {
  const previous = process.env.TMALL_CHANNEL_OPTION;
  process.env.TMALL_CHANNEL_OPTION = "1";
  try {
    assert.deepEqual(normalizeChannelOption({ channelOption: { value: "2" } }), { value: "2" });
    assert.deepEqual(normalizeChannelOption({ channelOption: { value: "2" } }, "1"), { value: "1" });
    assert.throws(() => normalizeChannelOption({ channelOption: { value: "5" } }), (error) => error.code === "channel_option_invalid");
  } finally {
    if (previous == null) delete process.env.TMALL_CHANNEL_OPTION;
    else process.env.TMALL_CHANNEL_OPTION = previous;
  }
});

test("submit response rejects HTTP 200 form errors", () => {
  const result = classifySubmitResponse(200, JSON.stringify({
    models: {
      globalMessage: { type: "error" },
      formError: { channelOption: { message: [{ code: "CHK_BASIC_ONEOF", msg: "输入值不在预期范围之内" }] } },
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "submit_validation_error");
  assert.equal(result.businessCode, "CHK_BASIC_ONEOF");
});

test("submit response accepts only an explicit success signal", () => {
  assert.equal(classifySubmitResponse(200, JSON.stringify({ models: { globalMessage: { type: "success" } } })).ok, true);
  assert.equal(classifySubmitResponse(200, "{}").code, "submit_response_unknown");
});

test("pure submit contract serializes the observed form fields without page events", () => {
  const form = makeForm();
  const global = {
    id: ITEM_ID,
    catId: "50000001",
    gpfRenderTrace: "mock-render-trace",
    globalExtendInfo: "{\"mock\":true}",
  };
  const { body, traceId } = buildSubmitBody(form, global);
  assert.equal(traceId, "mock-render-trace");
  assert.deepEqual([...body.keys()], [
    "isLightCombine", "isSetsCombine", "combineToNormal", "tmSpuPublishType", "isUnBondedGift", "spu_qf_param",
    "catId", "itemId", "jsonBody", "globalExtendInfo",
  ]);
  assert.deepEqual(JSON.parse(body.get("jsonBody")), form);
  assert.equal(body.get("globalExtendInfo"), "{\"mock\":true}");
});

test("server bootstrap parser extracts the form model without evaluating page code", () => {
  const form = makeForm();
  const parsed = extractServerFormFromHtml(bootstrapHtml(form));
  assert.equal(parsed.formValues.id, ITEM_ID);
  assert.equal(parsed.formValues.sku.length, 2);
  assert.equal(parsed.global.id, ITEM_ID);
});

test("server readback merges authoritative fields with runtime-only SKU metadata", () => {
  const fallback = makeForm();
  fallback.sku[0].skuPicture = { url: "runtime-only.jpg" };
  const server = clone(fallback);
  server.sku = server.sku.map((row, index) => ({
    skuId: `61258016975${39 + index}`,
    skuPrice: index === 0 ? "2399.00" : row.skuPrice,
    skuStock: 0,
    skuOuterId: row.skuOuterId,
    skuBarcode: row.skuBarcode,
    "skuParam_p-5569827": { value: Math.abs(Number(row.props[0].value)), text: row.props[0].text },
    "skuParam_p-1627207": { value: Math.abs(Number(row.props[1].value)), text: row.props[1].text },
  }));
  const merged = mergeServerForm(fallback, server);
  assert.equal(merged.sku[0].skuId, "6125801697539");
  assert.equal(merged.sku[0].skuPrice, "2399.00");
  assert.equal(merged.sku[0].skuPicture.url, "runtime-only.jpg");
  assert.equal(merged.sku[0].salePropKey, salePropKey(merged.sku[0].props));
});

test("SKU comparison canonicalizes order and IDs while checking every business field", () => {
  const original = [sku("5757013487113")];
  const rebuilt = [sku("6125801697539", { props: [...original[0].props].reverse(), action: { selected: true, transient: "ignored" } })];
  assert.equal(compareSkuRows(original, rebuilt).equal, true);
  assert.equal(compareSkuRows(original, [sku("6125801697539", { skuHolding: "21" })]).equal, false);
  assert.equal(compareSkuRows(original, [sku("6125801697539", { skuPicture: { url: "changed.jpg" } })]).equal, false);
  assert.equal(compareSkuRows(original, [sku("6125801697539", { props: original[0].props.map((prop, index) => index ? { ...prop, value: "-999" } : prop) })]).equal, false);
});

test("form summary keeps active current and old IDs without request secrets", () => {
  const summary = summarizeForm({
    channelOption: { value: "2" },
    saleProp: { "p-5569827": [{ text: "1.5米床", value: -1 }] },
    sku: [sku("6125801697539"), sku("0", { disabled: true })],
    oldsku: [{ skuId: "5757013487113" }],
  });
  assert.equal(summary.skuCount, 1);
  assert.deepEqual(summary.skuIds, ["6125801697539"]);
  assert.deepEqual(summary.oldSkuIds, ["6125801697539", "5757013487113"]);
  assert.equal(JSON.stringify(summary).includes("token"), false);
});

test("pure API two-phase rebuild matches reversed preview rows without page navigation", async () => {
  const page = new MockTmallPage();
  const result = await executeTmallRebuild(page, task());

  assert.equal(page.submitCount, 2);
  assert.equal(page.waitForUrlCalls, 0);
  assert.equal(page.reloadCalls, 0);
  assert.equal(page.gotoCalls.length, 0);
  assert.equal(page.getCount, 3);
  assert.deepEqual([...result.newSkuIds].sort(), ["6125801697539", "6125801697540"]);
  assert.equal(result.comparison.equal, true);

  const submitCalls = page.apiCalls.filter((entry) => new URL(entry.url).pathname === "/tmall/submit.htm");
  assert.equal(submitCalls.length, 2);
  assert.ok(submitCalls.every((entry) => entry.headers["X-Requested-With"] === "XMLHttpRequest"));
  assert.ok(submitCalls.every((entry) => entry.headers["X-XSRF-TOKEN"] === "mock-xsrf"));
  assert.ok(submitCalls.every((entry) => entry.headers["x-gpf-renderId"] === "mock-render-trace"));

  const temporary = page.submittedForms[0];
  assert.equal(temporary.gpfRenderTrace, "mock-render-trace");
  assert.equal(temporary.icmp_global.id, ITEM_ID);
  assert.notDeepEqual(temporary.saleProp["p-5569827"], makeForm().saleProp["p-5569827"]);
  assert.deepEqual(temporary.saleProp["p-1627207"], makeForm().saleProp["p-1627207"]);
  assert.equal(temporary.saleProp["p-5569827"].every((value) => value.text.length <= 30), true);
  assert.equal(temporary.sku.every((row) => !row.salePropKey.includes("---")), true);
  assert.deepEqual(page.submittedForms[1].saleProp, makeForm().saleProp);
  assert.deepEqual(page.submittedForms[1].sku.map((row) => row.skuPicture), makeForm().sku.map((row) => row.skuPicture));
});

test("two-phase rebuild uses API server bootstrap readback only", async () => {
  const page = new MockTmallPage();
  const readbacks = [];
  const result = await executeTmallRebuild(page, task(), { onReadback(entry) { readbacks.push(entry); } });

  assert.equal(page.submitCount, 2);
  assert.equal(page.waitForUrlCalls, 0);
  assert.deepEqual(readbacks.map((entry) => entry.strategy), ["api_server_bootstrap", "api_server_bootstrap"]);
  assert.ok(readbacks.every((entry) => entry.settled === true && entry.attempts === 1));
  assert.equal(page.gotoCalls.length, 0);
  assert.equal(result.comparison.equal, true);
});

test("malformed API bootstrap readback fails closed without page fallback", async () => {
  const page = new MockTmallPage(makeForm(), { fastReadbackHtml: "<html><body>changed</body></html>" });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => error.code === "server_form_model_missing");
  assert.equal(page.submitCount, 1);
  assert.equal(page.gotoCalls.length, 0);
  assert.equal(page.reloadCalls, 0);
});

test("post-write hook failures are recorded and cannot block the restore submit", async () => {
  const page = new MockTmallPage();
  const result = await executeTmallRebuild(page, task(), {
    onSnapshot(payload) {
      if (payload.phase === "temporary") throw new Error("audit persistence unavailable");
    },
    onWriteStart(payload) {
      if (payload.phase === "final_submit") throw new Error("phase persistence unavailable");
    },
  });
  assert.equal(page.submitCount, 2);
  assert.deepEqual(result.hookErrors.map((entry) => entry.hook).sort(), ["onSnapshot", "onWriteStart"]);
});

test("pure API transport never evaluates, clicks, reloads, or navigates the page", async () => {
  const page = new MockTmallPage();
  await executeTmallRebuild(page, task());
  assert.equal(page.gotoCalls.length, 0);
  assert.equal(page.reloadCalls, 0);
  assert.equal(page.waitForUrlCalls, 0);
  assert.equal(page.apiCalls.filter((entry) => entry.method === "POST").length, 4);
});

test("pre-write recovery snapshot persistence failure stops before the first request", async () => {
  const page = new MockTmallPage();
  await assert.rejects(executeTmallRebuild(page, task(), {
    onRecoverySnapshot() { throw new Error("disk unavailable"); },
  }), (error) => error.code === "prewrite_hook_failed");
  assert.equal(page.submitCount, 0);
});

test("item identity mismatch stops before preview or submit", async () => {
  const page = new MockTmallPage(makeForm(), { globalItemId: "999999999999" });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => error.code === "item_identity_mismatch");
  assert.equal(page.submitCount, 0);
});

test("duplicate generated SKU IDs fail exact temporary readback validation", async () => {
  const page = new MockTmallPage(makeForm(), { temporaryIds: ["6125801697539", "6125801697539"] });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => error.code === "temporary_readback_mismatch");
  assert.equal(page.submitCount, 1);
});

test("temporary property requires explicit custom-value metadata and capacity", async () => {
  const page = new MockTmallPage(makeForm(), {
    salePropMeta: [
      { key: "p-5569827", required: true, hasCustomProp: false, maxCustomItems: 0, maxLength: 30 },
      { key: "p-1627207", required: false, hasCustomProp: true, maxCustomItems: 1, maxLength: 30 },
    ],
  });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => error.code === "sale_prop_custom_value_unsupported");
  assert.equal(page.submitCount, 0);
});

test("a custom property with checkUrl is rejected unless its async validation is implemented", async () => {
  const page = new MockTmallPage(makeForm(), {
    salePropMeta: {
      "p-5569827": { name: "p-5569827", required: true, maxCustomItems: 0, maxLength: 30 },
      "p-1627207": {
        name: "p-1627207", required: false, hasCustomProp: true, maxCustomItems: 30, maxLength: 30,
        checkUrl: "asyncOpt.htm?optType=tmall_new_check_custom_color",
      },
    },
  });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => error.code === "sale_prop_custom_check_required");
  assert.equal(page.submitCount, 0);
});

test("preview rows cannot fall back to array position when a salePropKey is missing", async () => {
  const page = new MockTmallPage(makeForm(), {
    previewRows(rows) {
      return [{ ...rows[0], salePropKey: rows[1].salePropKey }, rows[1]];
    },
  });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => error.code === "sale_prop_preview_duplicate");
  assert.equal(page.submitCount, 0);
});
