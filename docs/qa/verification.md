# Verification

## Automated

- Source Worker defaults to demo mode.
- Demo batches generate deterministic replacement IDs and reach readback success.
- Live mode requires the exact confirmation phrase.
- Invalid item IDs and SKU-count mismatches are rejected.
- Requests from disallowed browser origins are rejected.
- Concurrent batches serialize and both complete.
- Live item locks survive Worker restart; a retry runs only the selected task.
- Both submit phases serialize and validate the intended form before direct HTTP submission.
- Snapshot, preview, both submits, and readback use the authenticated API request context without page evaluation, events, reloads, or navigation.
- Malformed bootstrap and canonical mapping failures fail closed without a page-operation fallback.
- The standalone rebuild preserves merchant codes, existing barcodes, images, prices, specifications, and other snapshot fields while returning only old/new SKU ID mappings.
- Add-pattern planning preserves every existing SKU row and ID, creates only explicitly listed missing combinations, and blocks ambiguous property/template mapping or field conflicts before writing.
- Existing-only add-pattern input completes without preview or submit POST; mixed input uses exactly one submit per product and strictly reads back newly assigned SKU IDs.
- Legacy `channelOption=5` and empty values stop before every preview/submit POST and enter task-level manual review; neither environment variables nor batch input can supply a replacement.
- A migration retry requires an explicit `1/2` selection plus confirmation, re-reads the current bootstrap, rejects source drift or unavailable/duplicate candidates, and strictly verifies the selected channel in final readback.
- Existing legal `1/2` values remain unchanged, including when a stale migration selection is presented; existing-only input remains zero-write after channel selection and does not claim that the online legacy value changed.
- Excel parsing preserves identifier strings, rejects formulas or missing headers, reports source rows, treats remarks as non-generative metadata, and caps a batch at 500 rows.
- Removed workflow routes return HTTP 404.
- v0.1.29 automated baseline: 76/76 tests passed in one Node process on Windows.
- Tauri host lifecycle includes a Windows Job Object regression path: the bundled Node process is attached with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so an abnormal host exit cannot leave the Worker orphaned while later Edge child processes remain outside the Job.

## Workbench UI

- The first screen is the operations desktop; SKU rebuild and add-pattern are mounted as independent persistent application modules.
- `SKU ID 重建`, `新增花型`, `任务中心`, and `浏览器会话` shortcuts support double-click and keyboard Enter.
- Both internal application windows support drag, resize, minimize, maximize, restore, close, and taskbar recovery.
- Closing or minimizing a window keeps its module mounted; the SKU text draft and parsed Excel preview remain available when reopened.
- The production parser read `加花型测试-9.18.xlsx` as 8 products and 23 explicit combinations; canceling the live confirmation generated zero task-creation requests.
- Playwright acceptance passed at `1440x900` and `1040x680` with four shortcuts, two mounted application instances, no page overflow, no console errors, and no failed network responses.
- A seeded zero-write migration task exposed the channel action only on that task. The dialog showed the raw old value `5`, offered only `1 纯电商` and `2 商场同款`, kept confirmation disabled until selection, and remained fully visible at both viewports.
- The add-pattern task drawer remained within the `1040x680` viewport and displayed the old value, zero-write status, task scope, and migration action without text overlap.

## Build

- v0.1.29 Vue/TypeScript production build passes (`3384` modules transformed); ExcelJS is emitted as a separate frontend asset.
- v0.1.29 Rust `cargo test` passes with no Rust unit tests registered; `cargo check` passes with the Windows Job Object dependency.
- `npm audit --omit=dev` reports 0 vulnerabilities after overriding ExcelJS's transitive UUID dependency to `11.1.1`.
- NSIS installer: `src-tauri/target/release/bundle/nsis/Tmall SKU Worker_0.1.29_x64-setup.exe`.
- NSIS size: `27,930,781` bytes; SHA-256: `D25563EE8528F8CFD23400EE924664AAC266F022E09121B0C37CEA2E89DE1A60`.
- MSI installer: `src-tauri/target/release/bundle/msi/Tmall SKU Worker_0.1.29_x64_en-US.msi`.
- MSI size: `41,553,139` bytes; SHA-256: `BDC6495EDFEB4809E16292458BA8CB5CA4D371FB67D218A0BA4910B06455EFCD`.
- Both locally built installers are unsigned (`Authenticode Status=NotSigned`).

## Installed Payload

- The isolated MSI application payload contains 179 files.
- Bundled Worker files are exactly `browser-url.mjs`, `server.mjs`, and `tmall-live-adapter.mjs`.
- Bundled Node packages are exactly `playwright` and `playwright-core`.
- ExcelJS is present only in compiled frontend assets; the Worker runtime has no ExcelJS, UUID, old workflow adapter, runtime credential, or MySQL package.
- Installed Worker files match source by SHA-256.
- The MSI administrative extraction Worker returned `workerVersion=0.1.29`, `mode=demo`, `unresolvedLiveWrites=0`, and `liveBatchConcurrency=2` from an isolated data directory.
- A real in-place NSIS upgrade from installed v0.1.28 returned exit status 0. The installed executable file/product versions and uninstall `DisplayVersion` all reported `0.1.29`; the Worker returned `mode=live`, `contract=configured`, `workflow.missing=[]`, and `unresolvedLiveWrites=0`.
- Read-only `/browser/verify` after upgrade reported the existing seller session valid with `navigator.webdriver=false`; the dedicated Edge main process remained PID `2024`.
- The installation was then rolled back with the frozen v0.1.28 NSIS package. Rollback returned exit status 0, restored all three version surfaces to `0.1.28`, and restarted the original Worker with its login session valid.
- The pre-upgrade and post-rollback 179-file installation manifests are byte-identical (SHA-256 `CDEAEA67EDE8C6A81AF528FB6B4106ECF2C465599CA7D537B2FEA01B0FFCBF13`); both exported installer registry keys are also byte-identical.
- The NSIS hooks were retained and execute before the generated running-app check; exact-path Worker cleanup continues to leave the dedicated Edge/Profile untouched.

## Browser Login Regression

- Login starts a normal headed system Edge with the application-owned `edge-profile-v2` and does not attach Playwright during login startup.
- `/browser/verify` checks only the Taobao/Tmall seller session.
- A verified session must retain `navigator.webdriver === false` before live writes are enabled.
- Risk challenges remain manual; the Worker does not operate sliders or repeatedly retry a blocked session.

## Deliberate Boundary

The v0.1.29 workbench exposes live SKU rebuild and add-pattern applications. SKU rebuild retains the two-phase API contract. Add Pattern preserves every original SKU and ID, treats each Excel row as one explicit desired combination, performs zero writes when all rows already match, and uses at most one submit per product otherwise. Legacy or empty sales channels require an explicit, task-scoped modern value that is revalidated against a fresh bootstrap; no automatic mapping or cross-task inheritance is permitted. Batches run at most two different item pipelines concurrently, while all Tmall submit requests remain serialized and same-item writes remain locked. Both workflows retain the 150-second final readback deadline and fresh deadline GET; issued writes are never retried automatically. Neither workflow calls OMS, queries or enriches external material/barcode data, or submits national-subsidy data. Final equivalence ignores only platform-managed `skuStock`; SKU count, identities, sale properties, price, merchant code, existing barcode, images, channel, and other business fields remain strict. The Tauri host Job Object uses silent child breakaway to preserve Edge, while NSIS preinstall/preuninstall hooks cover upgrades with a stale bundled Node process.

No live add-pattern write was issued for this release. The existing dedicated Edge session was used only for read-only login verification during upgrade acceptance. Broader authenticated property/template mapping for all eight sample products, the separate unsupported `180cm×220cm` capability on item `821393788284`, and any approved live add-pattern acceptance remain pending.

Historical verification for older multi-system releases remains in their versioned files under `docs/release/`.
