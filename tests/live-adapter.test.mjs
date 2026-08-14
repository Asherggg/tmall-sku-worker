import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySubmitResponse,
  compareSkuRows,
  executeTmallRebuild,
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

class MockTmallPage {
  constructor(form = makeForm(), options = {}) {
    this.serverForm = clone(form);
    this.pageForm = clone(form);
    this.options = options;
    this.globalItemId = options.globalItemId || form.id;
    this.salePropMeta = clone(options.salePropMeta || {
      "p-5569827": {
        name: "p-5569827", label: "适用床尺寸", uiType: "comboboxSaleProps", required: true,
        maxCustomItems: 9999, maxLength: 100, dataSource: [{ value: 32005284901, text: "1.5米床" }],
      },
      "p-1627207": {
        name: "p-1627207", label: "颜色分类", uiType: "newColorSelect", required: false,
        hasCustomProp: true, maxCustomItems: 30, maxLength: 130,
        checkUrl: "asyncOpt.htm?optType=tmall_new_check_custom_color",
      },
    });
    this._url = "about:blank";
    this.pendingSuccessUrl = null;
    this.submitCount = 0;
    this.gotoCalls = [];
    this.waitForUrlCalls = 0;
    this.reloadCalls = 0;
    this.setPageFormCount = 0;
    this.submittedForms = [];
    this.responseWaiter = null;
  }

  isClosed() { return false; }
  url() { return this._url; }

  async goto(url) {
    this.gotoCalls.push(url);
    this._url = url;
    this.pendingSuccessUrl = null;
    this.pageForm = clone(this.serverForm);
  }

  async reload() {
    this.reloadCalls += 1;
    throw new Error("adapter must not reload before the success navigation");
  }

  async waitForTimeout() {}

  async waitForURL(predicate) {
    this.waitForUrlCalls += 1;
    if (this.pendingSuccessUrl) {
      this._url = this.pendingSuccessUrl;
      this.pendingSuccessUrl = null;
    }
    if (!predicate(new URL(this._url))) throw new Error("unexpected navigation target");
  }

  waitForResponse(predicate) {
    return new Promise((resolve) => {
      this.responseWaiter = { predicate, resolve };
    });
  }

  async evaluate(fn, argument) {
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
      fetch: globalThis.fetch,
    };
    const had = {
      window: Object.hasOwn(globalThis, "window"),
      document: Object.hasOwn(globalThis, "document"),
      fetch: Object.hasOwn(globalThis, "fetch"),
    };
    globalThis.window = { GlobalStore: { engine: this.#engine() } };
    globalThis.document = { cookie: "XSRF-TOKEN=mock-xsrf" };
    globalThis.fetch = async (_url, init) => this.#previewResponse(init);
    try {
      return await fn(argument);
    } finally {
      for (const key of Object.keys(previous)) {
        if (had[key]) globalThis[key] = previous[key];
        else delete globalThis[key];
      }
    }
  }

  #engine() {
    return {
      getModels: (name) => {
        if (name === "formValues") return this.pageForm;
        if (name === "global") {
          return {
            value: { id: this.globalItemId, catId: "50000001", brand: { brandId: "600001" }, spuApply: "700001" },
            id: this.globalItemId,
            globalExtendInfo: "{\"mock\":true}",
          };
        }
        if (name === "formError") return {};
        return null;
      },
      getComponent: (name) => {
        if (name === "saleProp") {
          return {
            getProps: () => ({ value: this.pageForm.saleProp, subItems: this.salePropMeta }),
            setProps: ({ value }) => { this.pageForm.saleProp = clone(value); },
          };
        }
        if (name === "sku") return { setProps: ({ value }) => { this.pageForm.sku = clone(value); } };
        if (name === "channelOption") {
          return {
            getData: () => ({ props: { value: clone(this.pageForm.channelOption) } }),
            setProps: ({ value }) => {
              this.pageForm.channelOption = clone(value);
              this.setPageFormCount += 1;
              this.options.afterSetPageForm?.(this.pageForm, this.setPageFormCount);
            },
          };
        }
        if (name === "button-submit") return { emit: (event) => { if (event === "click") this.#submit(); } };
        return null;
      },
    };
  }

  #previewResponse(init) {
    const values = JSON.parse(new URLSearchParams(init.body).get("jsonBody"));
    let rows = values.sku.map((row) => ({
      salePropKey: salePropKey(row.props),
      skuId: 0,
      skuPicture: null,
      skuTitle: null,
      skuQuality: { value: "mainSku", text: "单品", prefilled: true },
    })).reverse();
    if (this.options.previewRows) rows = this.options.previewRows(rows, values);
    return {
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { value: rows } }),
    };
  }

  #submit() {
    this.submitCount += 1;
    const submitted = clone(this.pageForm);
    this.submittedForms.push(submitted);
    let savedRows = clone(submitted.sku);
    if (this.submitCount === 1) {
      const ids = this.options.temporaryIds || ["6125801697539", "6125801697540"];
      savedRows = savedRows.map((row, index) => ({ ...row, skuId: ids[index] }));
    }
    this.serverForm = { ...clone(submitted), sku: savedRows.reverse() };
    this.pendingSuccessUrl = `https://sell.publish.tmall.com/tmall/success.htm?id=${ITEM_ID}&phase=${this.submitCount}`;
    const responseBody = JSON.stringify({
      models: { globalMessage: { type: "success", successUrl: this.pendingSuccessUrl } },
    });
    const response = {
      request: () => ({ method: () => "POST" }),
      url: () => "https://sell.publish.tmall.com/tmall/submit.htm",
      status: () => 200,
      text: async () => responseBody,
    };
    const waiter = this.responseWaiter;
    this.responseWaiter = null;
    if (!waiter || !waiter.predicate(response)) throw new Error("submit response was not observed");
    waiter.resolve(response);
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

test("two-phase rebuild matches reversed preview rows by absolute salePropKey and waits for success navigation", async () => {
  const page = new MockTmallPage();
  const result = await executeTmallRebuild(page, task());

  assert.equal(page.submitCount, 2);
  assert.equal(page.waitForUrlCalls, 2);
  assert.equal(page.reloadCalls, 0);
  assert.equal(page.gotoCalls.length, 3);
  assert.deepEqual([...result.newSkuIds].sort(), ["6125801697539", "6125801697540"]);
  assert.equal(result.comparison.equal, true);

  const temporary = page.submittedForms[0];
  assert.notDeepEqual(temporary.saleProp["p-5569827"], makeForm().saleProp["p-5569827"]);
  assert.deepEqual(temporary.saleProp["p-1627207"], makeForm().saleProp["p-1627207"]);
  assert.equal(temporary.saleProp["p-5569827"].every((value) => value.text.length <= 30), true);
  assert.equal(temporary.sku.every((row) => !row.salePropKey.includes("---")), true);
  assert.deepEqual(page.submittedForms[1].saleProp, makeForm().saleProp);
  assert.deepEqual(page.submittedForms[1].sku.map((row) => row.skuPicture), makeForm().sku.map((row) => row.skuPicture));
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

test("temporary submit is not emitted when component side effects mutate the prepared form", async () => {
  const writePhases = [];
  const page = new MockTmallPage(makeForm(), {
    afterSetPageForm(form, count) {
      if (count === 1) form.sku[0].skuBarcode = "component-mutated-barcode";
    },
  });
  await assert.rejects(executeTmallRebuild(page, task(), {
    onWriteStart(entry) { writePhases.push(entry.phase); },
  }), (error) => error.code === "temporary_prewrite_state_mismatch");
  assert.equal(page.submitCount, 0);
  assert.deepEqual(writePhases, []);
});

test("final submit is not emitted when component side effects swap generated IDs", async () => {
  const writePhases = [];
  const page = new MockTmallPage(makeForm(), {
    afterSetPageForm(form, count) {
      if (count === 2) {
        [form.sku[0].skuId, form.sku[1].skuId] = [form.sku[1].skuId, form.sku[0].skuId];
      }
    },
  });
  await assert.rejects(executeTmallRebuild(page, task(), {
    onWriteStart(entry) { writePhases.push(entry.phase); },
  }), (error) => error.code === "final_prewrite_state_mismatch");
  assert.equal(page.submitCount, 1);
  assert.deepEqual(writePhases, ["temporary_submit"]);
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
