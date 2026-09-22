import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAddPatternForm,
  buildSubmitBody,
  classifySubmitResponse,
  compareSkuRows,
  detectPublishVariant,
  executeTmallAddPattern,
  executeTmallRebuild,
  extractServerFormFromHtml,
  finalReadbackDelayForAttempt,
  truncateReadbackHtmlAtModel,
  mergeServerForm,
  normalizeChannelOption,
  resolveTaskChannelOption,
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

function bootstrapHtml(form, salePropMeta = defaultSalePropMeta(), globalItemId = form.id, channelOptions = [
  { value: "1", text: "纯电商(只有线上销售)" },
  { value: "2", text: "商场同款(线上线下商场都销售)" },
]) {
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
    components: {
      saleProp: { props: { subItems: salePropMeta } },
      channelOption: { props: { dataSource: channelOptions } },
    },
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
    const request = { fetch: (url, init) => this.#apiFetch(url, init) };
    if (this.options.streamFetch) request.streamFetch = this.options.streamFetch;
    return {
      cookies: async () => [{ name: "XSRF-TOKEN", value: "mock-xsrf" }],
      request,
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
      let html = bootstrapHtml(this.serverForm, this.salePropMeta, this.globalItemId, this.options.channelOptions);
      if (this.submitCount > 0 && this.options.fastReadbackHtml) {
        html = typeof this.options.fastReadbackHtml === "function"
          ? this.options.fastReadbackHtml(this.serverForm, this.salePropMeta, this.globalItemId, { getCount: this.getCount, submitCount: this.submitCount })
          : this.options.fastReadbackHtml;
      }
      return this.#response(url, 200, html);
    }
    if (method === "POST" && parsedUrl.pathname === "/tmall/asyncOpt.htm" && parsedUrl.searchParams.get("optType") === "tmall_new_check_custom_color") {
      const body = new URLSearchParams(init.data);
      const payload = JSON.parse(body.get("jsonBody"));
      if (!payload?.text || !body.get("globalExtendInfo")) {
        return this.#response(url, 200, JSON.stringify({ models: { globalMessage: { type: "error", message: [{ code: "PUB_REQUEST_PARAM_INVALID", msg: "参数不能为空" }] } } }));
      }
      if (this.options.customCheckError) {
        return this.#response(url, 200, JSON.stringify({ models: { globalMessage: { type: "error", message: [{ msg: this.options.customCheckError }] } } }));
      }
      return this.#response(url, 200, JSON.stringify({ success: true, data: { level: 5 } }));
    }
    if (method === "POST" && parsedUrl.pathname === "/tmall/asyncOpt.htm") return this.#previewResponse(init, url);
    if (method === "POST" && parsedUrl.pathname === "/tmall/submit.htm") {
      const tracker = this.options.submitTracker;
      tracker?.start();
      try {
        if (this.options.submitDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.submitDelayMs));
        const body = new URLSearchParams(init.data);
        return this.#submit(JSON.parse(body.get("jsonBody")), url);
      } finally {
        tracker?.end();
      }
    }
    throw new Error(`unexpected API request: ${method} ${url}`);
  }

  #previewResponse(init, url) {
    const values = JSON.parse(new URLSearchParams(init.data).get("jsonBody"));
    const formatPreviewKey = this.options.singleDashPreviewKey
      ? (key) => key.split("_").map((pair) => pair.replace(/^(\d+)--(?=\d+$)/, "$1-")).join("_")
      : (key) => key;
    let rows = values.sku.map((row) => ({
      salePropKey: formatPreviewKey(salePropKey(row.props)),
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
    if (this.options.requiresSkuParam && submitted.sku.some((row) => !Object.keys(row).some((key) => key.startsWith("skuParam_p-")))) {
      return this.#response(url, 200, JSON.stringify({ models: { formError: { sku: { message: [{ code: "CHK_SKU_PARAM_REQUIRED_ERROR", msg: "缺少 SKU 参数" }] } } } }));
    }
    let savedRows = clone(submitted.sku);
    if (this.options.assignMissingSkuIds) {
      const ids = this.options.addedIds || ["7125801697539"];
      let addedIndex = 0;
      savedRows = savedRows.map((row) => /^\d+$/.test(String(row.skuId || ""))
        ? row
        : { ...row, skuId: ids[addedIndex++] });
    } else if (this.submitCount === 1) {
      const ids = this.options.temporaryIds || ["6125801697539", "6125801697540"];
      savedRows = savedRows.map((row, index) => ({ ...row, skuId: ids[index] }));
    } else if (this.options.finalStockDelta) {
      savedRows = savedRows.map((row, index) => index === 0
        ? { ...row, skuStock: Number(row.skuStock) + Number(this.options.finalStockDelta) }
        : row);
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

function patternTask(rows, overrides = {}) {
  return {
    id: "pattern-task-1",
    itemId: ITEM_ID,
    operation: "add_pattern",
    patternRows: rows,
    ...overrides,
  };
}

const existingPatternRow = (overrides = {}) => ({
  sourceRow: 2,
  specification: "1.5米床",
  color: "云影微澜",
  price: "2388.00",
  quantity: 0,
  merchantCode: "134460",
  barcode: "6942399076300",
  remark: "原花型不增加新规格",
  ...overrides,
});

const addedPatternRow = (overrides = {}) => ({
  sourceRow: 3,
  specification: "1.5米床",
  color: "晨雾蓝",
  price: "2499.00",
  quantity: 3,
  merchantCode: "234562",
  barcode: "6942399076302",
  remark: "新增花型",
  ...overrides,
});

test("channel option preserves legal page values and requires migration for legacy values", () => {
  const previous = process.env.TMALL_CHANNEL_OPTION;
  process.env.TMALL_CHANNEL_OPTION = "1";
  try {
    assert.deepEqual(normalizeChannelOption({ channelOption: { value: "2" } }), { value: "2" });
    assert.deepEqual(normalizeChannelOption({ channelOption: { value: "2" } }, "2"), { value: "2" });
    assert.throws(() => normalizeChannelOption({ channelOption: { value: "2" } }, "1"), (error) => error.code === "channel_option_override_forbidden");
    for (const value of ["5", "", null]) {
      assert.throws(() => normalizeChannelOption({ channelOption: { value } }), (error) => error.code === "channel_option_migration_required");
    }
    assert.deepEqual(normalizeChannelOption({ channelOption: { value: "5" } }, "1"), { value: "1" });
    assert.throws(() => normalizeChannelOption({ channelOption: { value: "5" } }, "5"), (error) => error.code === "channel_option_selection_invalid");
  } finally {
    if (previous == null) delete process.env.TMALL_CHANNEL_OPTION;
    else process.env.TMALL_CHANNEL_OPTION = previous;
  }
});

test("manual channel selection must appear exactly once in the current component", () => {
  const form = makeForm();
  form.channelOption = { value: "5" };
  const taskInput = patternTask([addedPatternRow()], { channelOption: "1", channelOptionSource: "5" });
  const state = { formValues: form, channelOptions: [{ value: "1", text: "纯电商" }, { value: "2", text: "商场同款" }] };
  assert.deepEqual(resolveTaskChannelOption(state, taskInput), { value: "1" });
  assert.equal(taskInput.channelOptionObserved, "5");
  assert.throws(() => resolveTaskChannelOption({ ...state, channelOptions: [{ value: "2" }] }, taskInput), (error) => error.code === "channel_option_not_offered");
  assert.throws(() => resolveTaskChannelOption({ ...state, channelOptions: [{ value: "1" }, { value: "1" }] }, taskInput), (error) => error.code === "channel_option_not_offered");
  assert.throws(() => resolveTaskChannelOption({ ...state, formValues: { ...form, channelOption: { value: "" } } }, taskInput), (error) => error.code === "channel_option_source_changed");
  assert.throws(() => resolveTaskChannelOption({ ...state, formValues: { ...form, channelOption: { value: "2" } } }, {
    ...taskInput, channelOptionSource: undefined,
  }), (error) => error.code === "channel_option_source_changed");
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
  assert.deepEqual(parsed.channelOptions.map((option) => option.value), ["1", "2"]);
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
  assert.equal(compareSkuRows(original, [sku("6125801697539", { skuStock: 1 })]).equal, false);
  const inventoryAgnostic = compareSkuRows(original, [sku("6125801697539", { skuStock: 1 })], { ignoreStock: true });
  assert.equal(inventoryAgnostic.equal, true);
  assert.deepEqual(inventoryAgnostic.ignoredFields, ["skuStock"]);
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

test("add-pattern planning preserves existing rows and creates only explicit missing combinations", () => {
  const original = makeForm();
  const plan = buildAddPatternForm(original, defaultSalePropMeta(), patternTask([
    existingPatternRow(),
    addedPatternRow(),
  ]));
  assert.equal(plan.existing.length, 1);
  assert.equal(plan.additions.length, 1);
  assert.equal(plan.formValues.sku.length, 3);
  assert.deepEqual(plan.formValues.sku.slice(0, 2), original.sku);
  const added = plan.additions[0].row;
  assert.equal(added.skuId, null);
  assert.equal(added.skuPrice, "2499.00");
  assert.equal(added.skuStock, 3);
  assert.equal(added.skuOuterId, "234562");
  assert.equal(added.skuBarcode, "6942399076302");
  assert.equal(added.props.find((prop) => prop.name === "p-1627207").text, "晨雾蓝");
  assert.equal(plan.formValues.saleProp["p-1627207"].some((value) => value.text === "晨雾蓝"), true);
});

test("add-pattern maps equivalent dimension spelling to existing and offered values", () => {
  const form = makeForm();
  for (const row of form.sku) {
    row.props = row.props.map((prop) => prop.name === "p-5569827" ? { ...prop, text: "150X210CM" } : prop);
  }
  form.saleProp["p-5569827"] = [{ value: -1001, text: "150X210CM" }];
  const meta = defaultSalePropMeta();
  meta["p-5569827"].dataSource = [
    { value: 32005284901, text: "150X210CM" },
    { value: 32005284902, text: "180x220cm" },
  ];
  const plan = buildAddPatternForm(form, meta, patternTask([
    existingPatternRow({ specification: "150cm×210cm" }),
    addedPatternRow({ specification: "180cm×220cm" }),
  ]));
  assert.equal(plan.existing.length, 1);
  assert.equal(plan.additions.length, 1);
  const specification = plan.additions[0].row.props.find((prop) => prop.name === "p-5569827");
  assert.equal(specification.value, 32005284902);
  assert.equal(specification.text, "180x220cm");
});

test("dimension equivalence does not collapse range or thickness differences", () => {
  for (const testCase of [
    { current: "180cmX（范围200-220）cm", requested: "180cm×200cm" },
    { current: "100*200cm", requested: "100cm×200cm×5cm" },
  ]) {
    const form = makeForm();
    for (const row of form.sku) {
      row.props = row.props.map((prop) => prop.name === "p-5569827" ? { ...prop, text: testCase.current } : prop);
    }
    form.saleProp["p-5569827"] = [{ value: -1001, text: testCase.current }];
    const meta = defaultSalePropMeta();
    meta["p-5569827"].dataSource = [{ value: 32005284901, text: testCase.current }];
    assert.throws(() => buildAddPatternForm(form, meta, patternTask([
      addedPatternRow({ specification: testCase.requested }),
    ])), (error) => error.code === "pattern_custom_value_unsupported");
  }
});

test("add-pattern builds newMeasurement structItems and mirrors SKU-detail parameters", () => {
  const form = makeForm();
  const currentStructItems = {
    "ts-1": "7",
    "ts-2": "-",
    "ts-3": "8",
    "ts-4": { text: "cm", value: 5 },
  };
  for (const row of form.sku) {
    row.props = row.props.map((prop) => prop.name === "p-5569827"
      ? { name: "p-250292780", value: -26128408, text: "7-8cm", structItems: clone(currentStructItems) }
      : prop);
    row["skuParam_p-250292780"] = { value: 26128408, text: "7-8cm", structItems: clone(currentStructItems) };
  }
  delete form.saleProp["p-5569827"];
  form.saleProp["p-250292780"] = [{ value: -26128408, text: "7-8cm", structItems: clone(currentStructItems) }];
  const meta = {
    "p-250292780": {
      name: "p-250292780",
      label: "高度",
      uiType: "newMeasurement",
      isMeasurement: true,
      maxLength: 100,
      maxCustomItems: 9999,
      dataSource: [{ value: -26128408, text: "7-8cm", structItems: clone(currentStructItems) }],
      structItems: [
        { name: "ts-1", uiType: "input", pattern: "([1-9][0-9]{0,9}|[0-9])(\\.[0-9]{0,4})?" },
        { name: "ts-2", uiType: "text", value: "-" },
        { name: "ts-3", uiType: "input", pattern: "([1-9][0-9]{0,9}|[0-9])(\\.[0-9]{0,4})?" },
        { name: "ts-4", uiType: "select", dataSource: [{ value: 1, text: "m" }, { value: 4, text: "dm" }, { value: 5, text: "cm" }] },
      ],
    },
    "p-1627207": defaultSalePropMeta()["p-1627207"],
  };
  const plan = buildAddPatternForm(form, meta, patternTask([
    addedPatternRow({ specification: "10-12cm" }),
  ]));
  assert.equal(plan.propertyKeys.specificationKey, "p-250292780");
  const added = plan.additions[0].row;
  const prop = added.props.find((entry) => entry.name === "p-250292780");
  const skuParam = added["skuParam_p-250292780"];
  assert.deepEqual(prop.structItems, {
    "ts-1": "10",
    "ts-2": "-",
    "ts-3": "12",
    "ts-4": { text: "cm", value: 5 },
  });
  assert.deepEqual(skuParam.structItems, prop.structItems);
  assert.equal(String(skuParam.value), String(prop.value).replace(/^-/, ""));
  assert.throws(() => buildAddPatternForm(form, meta, patternTask([
    addedPatternRow({ specification: "10到12cm" }),
  ])), (error) => error.code === "pattern_measurement_value_invalid");
});

test("add-pattern existing-only input completes without preview or submit", async () => {
  const page = new MockTmallPage();
  const result = await executeTmallAddPattern(page, patternTask([existingPatternRow()]));
  assert.equal(result.writeAttempted, false);
  assert.equal(result.existingCount, 1);
  assert.equal(result.additionCount, 0);
  assert.deepEqual(result.addedSkuIds, []);
  assert.equal(page.submitCount, 0);
  assert.equal(page.getCount, 1);
  assert.equal(page.apiCalls.filter((entry) => entry.method === "POST").length, 0);
});

test("add-pattern submits once, retains original SKU IDs, and reads back the new ID", async () => {
  const page = new MockTmallPage(makeForm(), { assignMissingSkuIds: true, addedIds: ["7125801697539"] });
  const phases = [];
  const readbacks = [];
  const result = await executeTmallAddPattern(page, patternTask([
    existingPatternRow(),
    addedPatternRow(),
  ]), {
    onPhase(entry) { phases.push(entry.phase); },
    onReadback(entry) { readbacks.push(entry); },
  });

  assert.equal(page.submitCount, 1);
  assert.equal(page.getCount, 2);
  assert.equal(result.writeAttempted, true);
  assert.equal(result.existingCount, 1);
  assert.equal(result.additionCount, 1);
  assert.deepEqual(result.addedSkuIds, ["7125801697539"]);
  assert.deepEqual([...result.existingSkuIds].sort(), ["5757013487113", "5757013487114"]);
  assert.equal(result.comparison.equal, true);
  assert.deepEqual(phases, ["reading_snapshot", "pattern_preparing", "pattern_submitting", "pattern_verifying", "pattern_verifying"]);
  assert.equal(readbacks[0].deadlineMs, 150_000);
  assert.equal(readbacks[0].settled, true);
  const submitted = page.submittedForms[0];
  assert.deepEqual(submitted.sku.slice(0, 2).map((row) => row.skuId), ["5757013487113", "5757013487114"]);
  assert.equal(submitted.sku[2].skuId, null);
  assert.equal(page.gotoCalls.length, 0);
  assert.equal(page.reloadCalls, 0);
  assert.equal(page.waitForUrlCalls, 0);
});

test("add-pattern accepts platform preview fields while preserving every original field", async () => {
  const page = new MockTmallPage(makeForm(), {
    assignMissingSkuIds: true,
    addedIds: ["7125801697539"],
    previewRows(rows) {
      return rows.map((row, index) => ({
        ...row,
        platformPreviewMetadata: { generated: true, index },
      }));
    },
  });
  const result = await executeTmallAddPattern(page, patternTask([
    existingPatternRow(),
    addedPatternRow(),
  ]));
  assert.equal(result.comparison.equal, true);
  assert.equal(page.submitCount, 1);
  assert.deepEqual(page.submittedForms[0].sku.slice(0, 2).map((row) => row.skuId), ["5757013487113", "5757013487114"]);
  assert.ok(page.submittedForms[0].sku.every((row) => row.platformPreviewMetadata?.generated === true));
});

test("legacy and empty channels block before any POST, including existing-only input", async () => {
  for (const value of ["5", ""]) {
    const form = makeForm();
    form.channelOption = { value };
    for (const rows of [[existingPatternRow()], [addedPatternRow()]]) {
      const page = new MockTmallPage(form);
      const currentTask = patternTask(rows);
      await assert.rejects(executeTmallAddPattern(page, currentTask), (error) => (
        error.code === "channel_option_migration_required" && error.observedValue === value
      ));
      assert.equal(currentTask.channelOptionObserved, value);
      assert.equal(page.getCount, 1);
      assert.equal(page.submitCount, 0);
      assert.equal(page.apiCalls.filter((entry) => entry.method === "POST").length, 0);
    }
    const rebuildPage = new MockTmallPage(form);
    await assert.rejects(executeTmallRebuild(rebuildPage, task()), (error) => error.code === "channel_option_migration_required");
    assert.equal(rebuildPage.apiCalls.filter((entry) => entry.method === "POST").length, 0);
  }
});

test("explicit channel migration submits once and verifies the selected value in fresh server readback", async () => {
  for (const [legacy, selected] of [["5", "1"], ["", "2"]]) {
    const form = makeForm();
    form.channelOption = { value: legacy };
    const page = new MockTmallPage(form, { assignMissingSkuIds: true });
    const currentTask = patternTask([addedPatternRow()], { channelOption: selected, channelOptionSource: legacy });
    const snapshots = [];
    const result = await executeTmallAddPattern(page, currentTask, { onRecoverySnapshot(value) { snapshots.push(value); } });
    assert.equal(result.comparison.equal, true);
    assert.equal(page.submitCount, 1);
    assert.equal(page.getCount, 2);
    assert.equal(page.submittedForms[0].channelOption.value, selected);
    assert.equal(page.serverForm.channelOption.value, selected);
    assert.equal(snapshots[0].channelOption.value, legacy);
    assert.equal(snapshots[0].plannedChannelOption.value, selected);
    assert.deepEqual(result.oldSkuIds, ["5757013487113", "5757013487114"]);
    assert.deepEqual(result.addedSkuIds, ["7125801697539"]);
  }
});

test("existing-only channel selection leaves the legacy channel unchanged", async () => {
  const form = makeForm();
  form.channelOption = { value: "5" };
  const page = new MockTmallPage(form);
  const snapshots = [];
  const result = await executeTmallAddPattern(page, patternTask([existingPatternRow()], {
    channelOption: "1", channelOptionSource: "5",
  }), { onSnapshot(value) { snapshots.push(value); } });
  assert.equal(result.writeAttempted, false);
  assert.deepEqual(snapshots.map((entry) => entry.summary.channelOption), ["5", "5"]);
  assert.equal(page.serverForm.channelOption.value, "5");
  assert.equal(page.apiCalls.filter((entry) => entry.method === "POST").length, 0);
});

test("selected channel unavailable in current component fails before preview and submit", async () => {
  const form = makeForm();
  form.channelOption = { value: "5" };
  const page = new MockTmallPage(form, { channelOptions: [{ value: "2", text: "商场同款" }] });
  await assert.rejects(executeTmallAddPattern(page, patternTask([addedPatternRow()], {
    channelOption: "1", channelOptionSource: "5",
  })), (error) => error.code === "channel_option_not_offered");
  assert.equal(page.apiCalls.filter((entry) => entry.method === "POST").length, 0);
});

test("legal current channels remain unchanged even with environment override", async () => {
  const previous = process.env.TMALL_CHANNEL_OPTION;
  process.env.TMALL_CHANNEL_OPTION = "1";
  try {
    const page = new MockTmallPage(makeForm(), { assignMissingSkuIds: true });
    const result = await executeTmallAddPattern(page, patternTask([addedPatternRow()]));
    assert.equal(result.comparison.equal, true);
    assert.equal(page.submittedForms[0].channelOption.value, "2");
    assert.equal(page.serverForm.channelOption.value, "2");
  } finally {
    if (previous == null) delete process.env.TMALL_CHANNEL_OPTION;
    else process.env.TMALL_CHANNEL_OPTION = previous;
  }
});

test("add-pattern blocks an existing-field mismatch before any write", async () => {
  const page = new MockTmallPage();
  await assert.rejects(
    executeTmallAddPattern(page, patternTask([existingPatternRow({ price: "9999.00" })])),
    (error) => error.code === "pattern_existing_field_mismatch",
  );
  assert.equal(page.submitCount, 0);
  assert.equal(page.apiCalls.filter((entry) => entry.method === "POST").length, 0);
});

test("detects SKU-detail pages and preserves required skuParam fields", async () => {
  const form = makeForm();
  form.sku[1].props = clone(form.sku[0].props);
  form.sku[0]["skuParam_p-5569827"] = { value: "1001", text: "1.5米床" };
  form.sku[1]["skuParam_p-5569827"] = { value: "1002", text: "1.5米床" };
  const page = new MockTmallPage(form, {
    requiresSkuParam: true,
    previewRows(rows) { return [rows[0]]; },
  });
  const result = await executeTmallRebuild(page, task());
  assert.equal(detectPublishVariant(form, defaultSalePropMeta()).kind, "sku_detail");
  assert.equal(result.skuCount, 2);
  assert.equal(page.submitCount, 2);
  assert.ok(page.submittedForms.every((submitted) => submitted.sku.every((row) => row["skuParam_p-5569827"])));
});

test("SKU-detail temporary identities keep props and skuParam fields aligned", async () => {
  const form = makeForm();
  for (const row of form.sku) {
    row["skuParam_p-1627207"] = { text: row.props[1].text, value: Number(String(row.props[1].value).replace(/^-/, "")) };
  }
  const page = new MockTmallPage(form, { requiresSkuParam: true, singleDashPreviewKey: true });
  await executeTmallRebuild(page, task());
  const temporaryRows = page.submittedForms[0].sku;
  assert.ok(temporaryRows.every((row) => {
    const prop = row.props.find((entry) => entry.name === "p-1627207");
    const param = row["skuParam_p-1627207"];
    return String(param.value) === String(prop.value).replace(/^-/, "") && param.text === prop.text;
  }));
  assert.deepEqual(page.submittedForms[1].sku.map((row) => row["skuParam_p-1627207"]), form.sku.map((row) => row["skuParam_p-1627207"]));
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
  assert.deepEqual(result.skuMappings, [
    { oldSkuId: "5757013487113", newSkuId: "6125801697539" },
    { oldSkuId: "5757013487114", newSkuId: "6125801697540" },
  ]);
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
  assert.deepEqual(page.submittedForms[1].sku.map((row) => row.skuOuterId), makeForm().sku.map((row) => row.skuOuterId));
  assert.deepEqual(page.submittedForms[1].sku.map((row) => row.skuBarcode), makeForm().sku.map((row) => row.skuBarcode));
  assert.deepEqual(page.submittedForms[1].sku.map((row) => row.skuPicture), makeForm().sku.map((row) => row.skuPicture));
});

test("preview responses may use an object map on alternate detail pages", async () => {
  const page = new MockTmallPage(makeForm(), {
    previewRows(rows) {
      return Object.fromEntries(rows.map((row) => [row.salePropKey, row]));
    },
  });
  const result = await executeTmallRebuild(page, task());
  assert.equal(result.skuCount, 2);
  assert.equal(page.submitCount, 2);
});

test("preview ignores only empty Cartesian placeholder combinations", async () => {
  const page = new MockTmallPage(makeForm(), {
    previewRows(rows) {
      return [...rows, {
        salePropKey: "1627207--999999999_5569827--1001",
        skuId: 0,
        skuPicture: null,
        skuTitle: null,
      }];
    },
  });
  const result = await executeTmallRebuild(page, task());
  assert.equal(result.skuCount, 2);
  assert.equal(page.submitCount, 2);
});

test("preview rejects extra combinations carrying an existing SKU identity", async () => {
  const page = new MockTmallPage(makeForm(), {
    previewRows(rows) {
      return [...rows, {
        salePropKey: "1627207--999999999_5569827--1001",
        skuId: "6125801697599",
      }];
    },
  });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => error.code === "sale_prop_preview_count_mismatch");
  assert.equal(page.submitCount, 0);
});

test("two-phase rebuild uses API server bootstrap readback only", async () => {
  const page = new MockTmallPage();
  const readbacks = [];
  const result = await executeTmallRebuild(page, task(), { onReadback(entry) { readbacks.push(entry); } });

  assert.equal(page.submitCount, 2);
  assert.equal(page.waitForUrlCalls, 0);
  assert.deepEqual(readbacks.map((entry) => entry.strategy), ["api_server_bootstrap", "api_server_bootstrap"]);
  assert.ok(readbacks.every((entry) => entry.transport === "browser_context_request"));
  assert.equal(page.gotoCalls.length, 0);
  assert.equal(result.comparison.equal, true);
});

test("final verification accepts platform inventory drift while retaining all other field checks", async () => {
  const page = new MockTmallPage(makeForm(), { finalStockDelta: 1 });
  const result = await executeTmallRebuild(page, task());

  assert.equal(page.submitCount, 2);
  assert.equal(result.comparison.equal, true);
  assert.deepEqual(result.comparison.ignoredFields, ["skuStock"]);
  assert.equal(page.serverForm.sku.some((row, index) => Number(row.skuStock) !== Number(makeForm().sku[index]?.skuStock)), true);
});

test("final readback accepts platform convergence at 109 seconds within the 150-second deadline", async () => {
  let clock = 0;
  const readbacks = [];
  const page = new MockTmallPage(makeForm(), {
    fastReadbackHtml(form, salePropMeta, itemId, context) {
      const stale = clone(form);
      if (context.submitCount === 2 && clock < 109_000) stale.sku[0].skuTitle = "平台仍在收敛";
      return bootstrapHtml(stale, salePropMeta, itemId);
    },
  });
  const result = await executeTmallRebuild(page, task(), {
    readbackTiming: {
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
      finalDelayMs: 10_000,
    },
    onReadback(entry) { readbacks.push(entry); },
  });
  const finalReadback = readbacks.find((entry) => entry.phase === "final_readback");
  assert.equal(result.comparison.equal, true);
  assert.equal(page.submitCount, 2);
  assert.equal(finalReadback.settled, true);
  assert.equal(finalReadback.deadlineMs, 150_000);
  assert.ok(finalReadback.durationMs >= 109_000 && finalReadback.durationMs < 150_000);
});

test("readback transport can stop after the server model without changing parsed data", async () => {
  const form = makeForm();
  const html = bootstrapHtml(form);
  const partial = truncateReadbackHtmlAtModel(html);
  assert.equal(partial.truncated, true);
  assert.equal(extractServerFormFromHtml(partial.html).formValues.id, ITEM_ID);
  assert.equal(extractServerFormFromHtml(partial.html).formValues.sku.length, form.sku.length);
  assert.equal(truncateReadbackHtmlAtModel("<html>no model</html>").truncated, false);
});

test("live readbacks can use the model-stream transport and keep the strict checks", async () => {
  const streamCalls = [];
  const page = new MockTmallPage(makeForm(), {
    streamFetch: async (url, init) => {
      streamCalls.push({ url, headers: init.headers });
      return new Response(bootstrapHtml(page.serverForm, page.salePropMeta, page.globalItemId), { status: 200 });
    },
  });
  const readbacks = [];
  const result = await executeTmallRebuild(page, task(), {
    readbackTiming: { streamHtml: true },
    onReadback(entry) { readbacks.push(entry); },
  });
  assert.equal(result.comparison.equal, true);
  assert.equal(streamCalls.length, 2);
  assert.ok(streamCalls.every((entry) => entry.headers.Cookie.includes("XSRF-TOKEN=mock-xsrf")));
  assert.ok(readbacks.every((entry) => entry.transport === "node_fetch_stream_until_model"));
});

test("final readback uses an aggressive early backoff without changing the hard deadline", async () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, "invalid"].map((attempt) => finalReadbackDelayForAttempt(attempt)),
    [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 500],
  );
  let clock = 0;
  const readbacks = [];
  const page = new MockTmallPage(makeForm(), {
    fastReadbackHtml(form, salePropMeta, itemId, context) {
      const stale = clone(form);
      if (context.submitCount === 2 && clock < 25_000) stale.sku[0].skuTitle = "平台仍在收敛";
      return bootstrapHtml(stale, salePropMeta, itemId);
    },
  });
  const result = await executeTmallRebuild(page, task(), {
    readbackTiming: {
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
    },
    onReadback(entry) { readbacks.push(entry); },
  });
  const finalReadback = readbacks.find((entry) => entry.phase === "final_readback");
  assert.equal(result.comparison.equal, true);
  assert.equal(finalReadback.settled, true);
  assert.equal(finalReadback.attempts, 7);
  assert.equal(finalReadback.durationMs, 25_500);
  assert.equal(page.getCount, 9);
});

test("phase callbacks expose non-sensitive phase and elapsed timing", async () => {
  const phases = [];
  await executeTmallRebuild(new MockTmallPage(), task(), { onPhase(entry) { phases.push(entry); } });
  assert.deepEqual(phases.map((entry) => entry.phase), [
    "reading_snapshot", "temp_submitting", "temp_verified", "restoring", "final_verifying",
  ]);
  assert.ok(phases.every((entry) => Number.isFinite(entry.durationMs) && entry.durationMs >= 0));
  assert.ok(phases.every((entry) => Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= entry.durationMs));
});

test("optional write lock serializes submit calls while allowing independent read phases", async () => {
  let tail = Promise.resolve();
  let activeSubmits = 0;
  let maxActiveSubmits = 0;
  const submitTracker = {
    start() {
      activeSubmits += 1;
      maxActiveSubmits = Math.max(maxActiveSubmits, activeSubmits);
    },
    end() { activeSubmits -= 1; },
  };
  const withWriteLock = (operation) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    return previous.then(async () => {
      try { return await operation(); } finally { release(); }
    });
  };
  const first = new MockTmallPage(makeForm("742063162901"), { submitTracker, submitDelayMs: 20 });
  const second = new MockTmallPage(makeForm("742063162902"), { submitTracker, submitDelayMs: 20 });
  await Promise.all([
    executeTmallRebuild(first, task({ id: "task-a", itemId: "742063162901" }), { withWriteLock }),
    executeTmallRebuild(second, task({ id: "task-b", itemId: "742063162902" }), { withWriteLock }),
  ]);
  assert.equal(maxActiveSubmits, 1);
  assert.equal(activeSubmits, 0);
  assert.equal(first.submitCount, 2);
  assert.equal(second.submitCount, 2);
});
test("final readback performs a fresh GET when an in-flight response crosses the deadline", async () => {
  let clock = 0;
  let crossed = false;
  const readbacks = [];
  const page = new MockTmallPage(makeForm(), {
    fastReadbackHtml(form, salePropMeta, itemId, context) {
      const stale = clone(form);
      if (context.submitCount === 2 && !crossed) {
        crossed = true;
        clock = 150_001;
        stale.sku[0].skuTitle = "平台仍在收敛";
      }
      return bootstrapHtml(stale, salePropMeta, itemId);
    },
  });
  const result = await executeTmallRebuild(page, task(), {
    readbackTiming: {
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
    },
    onReadback(entry) { readbacks.push(entry); },
  });
  const finalReadback = readbacks.find((entry) => entry.phase === "final_readback");
  assert.equal(result.comparison.equal, true);
  assert.equal(finalReadback.attempts, 2);
  assert.equal(finalReadback.deadlineReadback, true);
  assert.equal(page.getCount, 4);
});

test("final readback performs one fresh GET at the 150-second deadline before manual review", async () => {
  let clock = 0;
  const readbacks = [];
  const page = new MockTmallPage(makeForm(), {
    fastReadbackHtml(form, salePropMeta, itemId, context) {
      const stale = clone(form);
      if (context.submitCount === 2) stale.sku[0].skuTitle = "平台仍在收敛";
      return bootstrapHtml(stale, salePropMeta, itemId);
    },
  });
  await assert.rejects(executeTmallRebuild(page, task(), {
    readbackTiming: {
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
      finalDelayMs: 40_000,
    },
    onReadback(entry) { readbacks.push(entry); },
  }), (error) => error.code === "final_field_mismatch");
  const finalReadback = readbacks.find((entry) => entry.phase === "final_readback");
  assert.equal(page.submitCount, 2);
  assert.equal(finalReadback.settled, false);
  assert.equal(finalReadback.durationMs, 150_000);
  assert.equal(finalReadback.deadlineReadback, true);
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

test("a custom property with checkUrl runs the page-compatible async validation before preview", async () => {
  const page = new MockTmallPage(makeForm(), {
    salePropMeta: {
      "p-5569827": { name: "p-5569827", required: true, maxCustomItems: 0, maxLength: 30 },
      "p-1627207": {
        name: "p-1627207", required: false, hasCustomProp: true, maxCustomItems: 30, maxLength: 30,
        checkUrl: "asyncOpt.htm?optType=tmall_new_check_custom_color",
      },
    },
  });
  const result = await executeTmallRebuild(page, task());
  assert.equal(result.skuCount, 2);
  const checks = page.apiCalls.filter((entry) => new URL(entry.url).searchParams.get("optType") === "tmall_new_check_custom_color");
  assert.equal(checks.length, 2);
  assert.ok(checks.every((entry) => entry.method === "POST"));
  assert.ok(checks.every((entry) => new URL(entry.url).searchParams.get("pid") === "1627207"));
  assert.ok(checks.every((entry) => {
    const body = new URLSearchParams(entry.body);
    return JSON.parse(body.get("jsonBody"))?.text && body.get("globalExtendInfo") === "{\"mock\":true}";
  }));
  assert.equal(page.submitCount, 2);
});

test("custom property validation errors stop before any write", async () => {
  const page = new MockTmallPage(makeForm(), {
    customCheckError: "自定义颜色不允许",
    salePropMeta: {
      "p-5569827": { name: "p-5569827", required: true, maxCustomItems: 0, maxLength: 30 },
      "p-1627207": {
        name: "p-1627207", required: false, hasCustomProp: true, maxCustomItems: 30, maxLength: 30,
        checkUrl: "asyncOpt.htm?optType=tmall_new_check_custom_color",
      },
    },
  });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => error.code === "sale_prop_custom_check_rejected");
  assert.equal(page.submitCount, 0);
});

test("preview accepts the alternate single-dash key used by SKU-detail pages", async () => {
  const form = makeForm();
  for (const row of form.sku) {
    row["skuParam_p-1627207"] = { text: row.props[1].text, value: String(row.props[1].value).replace(/^-/, "") };
  }
  const page = new MockTmallPage(form, { singleDashPreviewKey: true, requiresSkuParam: true });
  const result = await executeTmallRebuild(page, task());
  assert.equal(result.skuCount, 2);
  assert.equal(page.submitCount, 2);
});

test("preview rows cannot fall back to array position when a salePropKey is missing", async () => {
  const page = new MockTmallPage(makeForm(), {
    previewRows(rows) {
      return [{ ...rows[0], salePropKey: rows[1].salePropKey }, rows[1]];
    },
  });
  await assert.rejects(executeTmallRebuild(page, task()), (error) => ["sale_prop_preview_duplicate", "sale_prop_preview_count_mismatch"].includes(error.code));
  assert.equal(page.submitCount, 0);
});
