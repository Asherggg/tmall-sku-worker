# Verification

## Automated

- Worker health defaults to demo.
- Demo batches generate deterministic replacement IDs and reach readback success.
- Live mode requires the exact confirmation phrase.
- Invalid item IDs and SKU-count mismatches are rejected.
- Requests from disallowed browser origins are rejected.
- Concurrent batches serialize and both complete.

## Build

- Vue/TypeScript production build passes.
- Rust `cargo check` passes.
- Tauri release executable builds at `src-tauri/target/release/tmall-sku-worker.exe`.
- MSI generation did not complete because the WiX binary download timed out; application compilation itself succeeded.

## UI smoke

Playwright launched the installed Edge channel headlessly, loaded the console, created a two-SKU demo batch through the rendered UI, waited for completion, and captured overview and queue screenshots without page errors. A second UI pass imported 50 SKUs across five products and confirmed grouping counts of 5/50 with zero validation errors.

## Browser login regression (v0.1.2)

- Started installed Edge directly with a clean application-owned `edge-profile-v2`; Playwright was not imported or attached during login startup.
- Attached only after the explicit verify action and measured `navigator.webdriver === false`.
- Hid and restored the same headed Edge window; CDP Browser ID stayed unchanged.
- Verified no second Edge instance and no headless transition were created by hide/restore.
- Repeated challenge handling remains explicit: stop retries and report `captcha_or_risk_required`; the Worker never operates a slider.

## Deliberate boundary

The generic live Tmall executor is not enabled. The worker records `adapter_contract_missing` or `live_executor_not_enabled` and sends no write request. A real adapter requires a versioned submit contract plus post-submit readback fixtures for each supported page schema.
