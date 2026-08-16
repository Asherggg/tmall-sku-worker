# Tmall SKU Rebuild Console

Tauri 2 + Vue 3 desktop console with a local Node/Playwright worker for audited, item-scoped SKU rebuilds.

## Quick start

```powershell
npm install
npm run tauri:dev
```

For browserless UI development, run `npm run dev` and open the printed Vite URL. To run only the worker:

```powershell
$env:TMALL_DATA_DIR = "$PWD\\.runtime\\tmall-worker"
npm run worker
```

The source worker defaults to **demo mode**. Demo tasks exercise the complete queue, two-phase rebuild state machine, readback, pause/retry, and audit UI without modifying Tmall. The Windows v0.1.6 desktop build enables the reviewed `tmall-publish-v1` adapter and still requires the exact confirmation phrase `确认线上重建` before a live batch can start.

## Browser lifecycle

On Windows the worker starts the installed Edge with an application-owned `edge-profile-v2`. During login it does **not** launch or attach Playwright. After the user finishes login, `/browser/verify` attaches once through a fixed loopback CDP port and checks all Tmall/Taobao tabs. `/browser/hide` hides the same headed Edge window with Win32; it does not close the browser, create another process, or switch to headless mode. The profile remains under the worker data directory, and no cookies or tokens are written to the repository.

This v2 profile is intentionally separate from the earlier Playwright-launched profile. If a page enters a repeated risk challenge, stop retrying and leave the old profile untouched; repeated challenge attempts are not automated.

## Windows installer

`npm run tauri:build` produces a Windows NSIS installer (and MSI when the local WiX toolchain is available). The NSIS wizard supports choosing a per-user installation directory, so no administrator account is required by default. The installer bundles the Node runtime and the two Playwright packages used by the Worker; an installed copy does not depend on Node being present on `PATH`.

The app still requires Microsoft Edge and WebView2 on Windows. Login is performed manually in the dedicated headed Edge profile. The v0.1.6 installer is the live rebuild edition: it reads the current item form from the logged-in page, performs a temporary unique-spec submit, uses fast server readback with full-page fallback to capture new SKU IDs, restores the original fields, submits again, and verifies the final readback. It invokes the page's internal submit event and same-origin HTTP APIs; it does not simulate DOM clicks.

Live execution remains fail-closed. A CAPTCHA/risk page, invalid channel value, local validation error, HTTP/business error, unknown submit response, ID mismatch, or field mismatch moves the task to `needs_manual_review` and is never blindly retried.

Before upgrading, exit the older desktop process so it releases loopback port `19828`. The v0.1.6 UI checks the connected Worker version and disables live mode when an older Worker or an unconfigured contract is still running.

## Verification

```powershell
npm test
npm run build
npm run prepare:runtime
cargo check --manifest-path src-tauri/Cargo.toml
```

See [docs/product/PRD.md](docs/product/PRD.md), [docs/design/desktop-console.md](docs/design/desktop-console.md), and [docs/architecture/design.md](docs/architecture/design.md) for the product contract and safety boundaries.
