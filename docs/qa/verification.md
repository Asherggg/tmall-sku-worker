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
- Automated suite: 56/56 passed for v0.1.20, including runtime config file loading for the remote inventory API, OMS response classification/readback, Doris material uniqueness and barcode enrichment, subsidy XLSX column filling, inventory-only drift acceptance, `newColorSelect` POST validation, alternate preview-key formats, SKU-detail parameter synchronization, 109-second convergence within the 150-second deadline, the deadline-point final GET, three-page login verification, and guarded Cartesian-placeholder filtering.

## Build

- Vue/TypeScript production build passes.
- Rust `cargo check` passes.
- Tauri release executable builds at `src-tauri/target/release/tmall-sku-worker.exe`.
- The v0.1.20 NSIS installer builds at `src-tauri/target/release/bundle/nsis/Tmall SKU Worker_0.1.20_x64-setup.exe`; size `30,814,661` bytes; SHA-256 is `1C1E4248391BB0CC775AEC124063AA2852330AC5A14C839D872FC87D77C30D3C`.
- Installation to `D:\Tmall SKU Worker` completed successfully. Installed Worker/config modules match the repository by SHA-256; installed `/health` returned `workerVersion=0.1.20`, `inventory.configured=true`, `subsidy.configured=true`, and `contract=configured`. The installed `/inventory/lookup` successfully read the configured remote API.
- Real subsidy submission test for `1061776009736` completed successfully: 9 template rows matched, upload completed, the page showed a success result, and list readback verified all 9 new SKU/69-code pairs.
- MSI packaging remains unverified because the external WiX toolchain download timed out; the verified release artifact is NSIS.

## UI smoke

Playwright launched the installed Edge channel headlessly, loaded the console, created a two-SKU demo batch through the rendered UI, waited for completion, and captured overview and queue screenshots without page errors. A second UI pass imported 50 SKUs across five products and confirmed grouping counts of 5/50 with zero validation errors.

## Browser login regression (v0.1.2)

- Started installed Edge directly with a clean application-owned `edge-profile-v2`; Playwright was not imported or attached during login startup.
- Attached only after the explicit verify action and measured `navigator.webdriver === false`.
- Hid and restored the same headed Edge window; CDP Browser ID stayed unchanged.
- Verified no second Edge instance and no headless transition were created by hide/restore.
- Repeated challenge handling remains explicit: stop retries and report `captcha_or_risk_required`; the Worker never operates a slider.

## Deliberate boundary

The v0.1.20 source exposes only live mode in the desktop UI, retains an explicit confirmation dialog without typed confirmation, and limits the expanded batch preview to 10 items inside a fixed-height scrolling region. Live workflow configuration must include the OMS adapter, a Doris lookup transport, and the guarded subsidy adapter. Runtime workflow settings are read from the app data `runtime-config.json`; secrets are not bundled or exported. Final equivalence ignores `skuStock` only; SKU count, IDs, sale properties, price, merchant code, barcode, images, and other business fields remain strict. The live adapter also preserves legacy `skuParam_p-*` fields, maps multiple SKU-detail rows sharing one sale-property combination, uses the page-compatible custom-property POST contract, accepts both observed sale-property key formats, synchronizes mirrored SKU-detail parameters, and ignores only demonstrably empty Cartesian placeholder rows. Final readback performs read-only GET polling to a 150-second deadline and one final fresh GET at that deadline. Login verification checks seller, OMS, and subsidy tabs without invoking business endpoints. Worker tests continue to cover the direct submit contract, readback, runtime config loading, item locks, field comparison, deletion audit behavior, and explicit confirmation before releasing an unresolved write lock.

The preview smoke test imported 15 product IDs at a 1280 x 820 viewport and verified 10 rendered rows, a 270 px scroll viewport, `overflow-y:auto`, and the remaining-count message.
