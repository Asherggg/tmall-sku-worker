# Verification

## Automated

- Worker health defaults to demo.
- Demo batches generate deterministic replacement IDs and reach readback success.
- Live mode requires the exact confirmation phrase.
- Invalid item IDs and SKU-count mismatches are rejected.
- Requests from disallowed browser origins are rejected.
- Concurrent batches serialize and both complete.
- Live item locks survive Worker restart; a retry runs only the selected task.
- Both submit phases re-read and validate the page's actual form state before emitting the internal submit event.
- Automated suite: 33/33 passed for v0.1.3.

## Build

- Vue/TypeScript production build passes.
- Rust `cargo check` passes.
- Tauri release executable builds at `src-tauri/target/release/tmall-sku-worker.exe`.
- NSIS installer builds at `src-tauri/target/release/bundle/nsis/Tmall SKU Worker_0.1.3_x64-setup.exe`.
- Silent custom-directory installation completed successfully. Installed Worker sources match the repository by SHA-256, and the bundled Node runtime imports Playwright 1.62.1.
- The installed Worker smoke check returned `workerVersion=0.1.3`, `mode=live`, and `contract=configured` on an isolated loopback port.

## UI smoke

Playwright launched the installed Edge channel headlessly, loaded the console, created a two-SKU demo batch through the rendered UI, waited for completion, and captured overview and queue screenshots without page errors. A second UI pass imported 50 SKUs across five products and confirmed grouping counts of 5/50 with zero validation errors.

## Browser login regression (v0.1.2)

- Started installed Edge directly with a clean application-owned `edge-profile-v2`; Playwright was not imported or attached during login startup.
- Attached only after the explicit verify action and measured `navigator.webdriver === false`.
- Hid and restored the same headed Edge window; CDP Browser ID stayed unchanged.
- Verified no second Edge instance and no headless transition were created by hide/restore.
- Repeated challenge handling remains explicit: stop retries and report `captcha_or_risk_required`; the Worker never operates a slider.

## Deliberate boundary

The v0.1.3 desktop build enables the versioned `tmall-publish-v1` executor. Unit tests cover channel allowlisting, HTTP-200 business-error classification, unknown-response fail-closed behavior, page-state mutation detection, two-phase navigation/readback, exact ID mapping, item-level write locks, and semantic SKU comparison. Installer verification does not execute a real product write; acceptance still requires one confirmed test item to complete temporary submit/readback, restore/final submit, and final field/ID readback.
