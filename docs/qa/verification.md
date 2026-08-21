# Verification

## Automated

- Worker health defaults to demo.
- Demo batches generate deterministic replacement IDs and reach readback success.
- Live mode requires the exact confirmation phrase.
- Invalid item IDs and SKU-count mismatches are rejected.
- Requests from disallowed browser origins are rejected.
- Concurrent batches serialize and both complete.
- Live item locks survive Worker restart; a retry runs only the selected task.
- Both submit phases serialize and validate the intended form before direct HTTP submission.
- Snapshot, preview, both submits, and readback use the authenticated API request context without page evaluation, events, reloads, or navigation.
- Malformed bootstrap and canonical mapping failures fail closed without a page-operation fallback.
- Automated suite: v0.1.23 基线包含 63 项 Worker/适配器测试，覆盖固定商品资料接口不受旧运行时配置覆盖、Tauri 环境令牌注入、国补默认开启、MTop 签名、`IMPORT` 不重试、OSS 域名白名单、dry-run 不跨写入边界，以及 SKU/69 码/品名/规格严格回读。
- Subsidy API dry-run for `1061776009736`: reused the logged-in dedicated Edge profile, exported and downloaded a fresh 9-row template, filled all rows, and uploaded the XLSX to temporary OSS storage with HTTP 200. `writeStarted=false`; no `IMPORT` request was sent. Evidence is stored under `.runtime/subsidy-api-dry-run-1061776009736-1787282125325/`.
- Subsidy API live import for `1061776009736`: after explicit user confirmation, the v0.1.21 adapter exported, filled, uploaded, and sent `IMPORT` once; all MTop/OSS operations returned HTTP 200 / `SUCCESS`. The first bounded server readback strictly verified all 9 SKU IDs, barcodes, subsidy product names, and specifications. Redacted evidence is stored under `.runtime/subsidy-api-live-0.1.21-1061776009736-1787287483490/`.

## Build

- v0.1.23 Vue/TypeScript production build passes.
- v0.1.23 Rust `cargo test` passes 2/2 and `cargo check` passes.
- v0.1.23 NSIS installer builds at `src-tauri/target/release/bundle/nsis/Tmall SKU Worker_0.1.23_x64-setup.exe`; size `30,822,423` bytes; SHA-256 is `4FF52D05F27F08CE54A55F5EB75D8D25C4E713925D7420250D3382393231A789`.
- The release resource contains the fixed inventory credential generated from the controlled release config and is ignored by Git. Bundled Worker/inventory files match source by SHA-256.
- The bundled Worker started on an isolated port and returned `workerVersion=0.1.23`, `mode=live`, `contract=configured`, the fixed inventory API URL, `subsidy.configured=true`, and no missing workflow components; the isolated process was then stopped.
- The v0.1.20 NSIS installer builds at `src-tauri/target/release/bundle/nsis/Tmall SKU Worker_0.1.20_x64-setup.exe`; size `30,814,661` bytes; SHA-256 is `1C1E4248391BB0CC775AEC124063AA2852330AC5A14C839D872FC87D77C30D3C`.
- Installation to `D:\Tmall SKU Worker` remains on v0.1.20 during this development verification so the active logged-in session was not interrupted. The v0.1.21 bundled Worker was instead started from `src-tauri/target/release` on isolated port `19921`; `/health` returned `workerVersion=0.1.21`, `mode=demo`, and `contract=demo`, then the temporary process was stopped.
- Real subsidy submission test for `1061776009736` completed successfully: 9 template rows matched, upload completed, the page showed a success result, and list readback verified all 9 new SKU/69-code pairs.
- NSIS installer builds at `src-tauri/target/release/bundle/nsis/Tmall SKU Worker_0.1.21_x64-setup.exe`; size `30,817,510` bytes; SHA-256 is `FBFFE5B82A56D900144B852D33C733D5DECC023104260E37ABD66BAA7FC15967`. The bundled release resources include `worker/subsidy-api-adapter.mjs`.
- MSI packaging remains unverified because the external WiX toolchain download timed out; the verified v0.1.21 release artifact is NSIS.

## UI smoke

Playwright launched the installed Edge channel headlessly, loaded the console, created a two-SKU demo batch through the rendered UI, waited for completion, and captured overview and queue screenshots without page errors. A second UI pass imported 50 SKUs across five products and confirmed grouping counts of 5/50 with zero validation errors.

## Browser login regression (v0.1.2)

- Started installed Edge directly with a clean application-owned `edge-profile-v2`; Playwright was not imported or attached during login startup.
- Attached only after the explicit verify action and measured `navigator.webdriver === false`.
- Hid and restored the same headed Edge window; CDP Browser ID stayed unchanged.
- Verified no second Edge instance and no headless transition were created by hide/restore.
- Repeated challenge handling remains explicit: stop retries and report `captcha_or_risk_required`; the Worker never operates a slider.

## Deliberate boundary

The v0.1.23 source exposes only live mode in the desktop UI and has no workflow configuration page. The inventory endpoint is fixed at `http://10.21.16.213:9031/v1/materials/lookup`; subsidy is always enabled. The release credential is generated into a Git-ignored package resource and injected only into the Worker process by Tauri. Runtime configuration cannot override the fixed endpoint, credential, or subsidy enablement. Final equivalence ignores `skuStock` only; SKU count, IDs, sale properties, price, merchant code, barcode, images, and other business fields remain strict. The live adapter also preserves legacy `skuParam_p-*` fields, maps multiple SKU-detail rows sharing one sale-property combination, uses the page-compatible custom-property POST contract, accepts both observed sale-property key formats, synchronizes mirrored SKU-detail parameters, and ignores only demonstrably empty Cartesian placeholder rows. Final readback performs read-only GET polling to a 150-second deadline and one final fresh GET at that deadline. Login verification checks seller, OMS, and subsidy tabs without invoking business endpoints. Worker tests continue to cover the direct submit contract, readback, runtime config loading, item locks, field comparison, deletion audit behavior, and explicit confirmation before releasing an unresolved write lock.

The preview smoke test imported 15 product IDs at a 1280 x 820 viewport and verified 10 rendered rows, a 270 px scroll viewport, `overflow-y:auto`, and the remaining-count message.
