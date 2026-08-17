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
- Automated suite: 38/38 passed for v0.1.12.

## Build

- Vue/TypeScript production build passes.
- Rust `cargo check` passes.
- Tauri release executable builds at `src-tauri/target/release/tmall-sku-worker.exe`.
- The v0.1.12 NSIS installer builds at `src-tauri/target/release/bundle/nsis/Tmall SKU Worker_0.1.12_x64-setup.exe`.
- NSIS installer builds at `src-tauri/target/release/bundle/nsis/Tmall SKU Worker_0.1.6_x64-setup.exe`.
- Silent custom-directory installation completed successfully. Installed Worker sources match the repository by SHA-256, and the bundled Node runtime imports Playwright 1.62.1.
- The installed Worker smoke check returned `workerVersion=0.1.6`, `mode=live`, and `contract=configured` on an isolated loopback port.

## UI smoke

Playwright launched the installed Edge channel headlessly, loaded the console, created a two-SKU demo batch through the rendered UI, waited for completion, and captured overview and queue screenshots without page errors. A second UI pass imported 50 SKUs across five products and confirmed grouping counts of 5/50 with zero validation errors.

## Browser login regression (v0.1.2)

- Started installed Edge directly with a clean application-owned `edge-profile-v2`; Playwright was not imported or attached during login startup.
- Attached only after the explicit verify action and measured `navigator.webdriver === false`.
- Hid and restored the same headed Edge window; CDP Browser ID stayed unchanged.
- Verified no second Edge instance and no headless transition were created by hide/restore.
- Repeated challenge handling remains explicit: stop retries and report `captcha_or_risk_required`; the Worker never operates a slider.

## Deliberate boundary

The v0.1.12 source exposes only live mode in the desktop UI, retains an explicit confirmation dialog without typed confirmation, and limits the expanded batch preview to 10 items inside a fixed-height scrolling region. Worker tests continue to cover the direct submit contract, readback, item locks, field comparison, deletion audit behavior, and explicit confirmation before releasing an unresolved write lock.

The preview smoke test imported 15 product IDs at a 1280 x 820 viewport and verified 10 rendered rows, a 270 px scroll viewport, `overflow-y:auto`, and the remaining-count message. The installed Worker returned `workerVersion=0.1.12`, `mode=live`, and `contract=configured`.
