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

The console defaults to **demo mode**. Demo tasks exercise the complete queue, two-phase rebuild state machine, readback, pause/retry, and audit UI without modifying Tmall. Live mode is intentionally disabled unless the worker is started with `TMALL_LIVE_ENABLED=true` and a reviewed adapter contract; the current MVP reports the missing contract instead of guessing an internal endpoint.

## Browser lifecycle

On Windows the worker starts the installed Edge with an application-owned `edge-profile-v2`. During login it does **not** launch or attach Playwright. After the user finishes login, `/browser/verify` attaches once through a fixed loopback CDP port and checks all Tmall/Taobao tabs. `/browser/hide` hides the same headed Edge window with Win32; it does not close the browser, create another process, or switch to headless mode. The profile remains under the worker data directory, and no cookies or tokens are written to the repository.

This v2 profile is intentionally separate from the earlier Playwright-launched profile. If a page enters a repeated risk challenge, stop retrying and leave the old profile untouched; repeated challenge attempts are not automated.

## Windows installer

`npm run tauri:build` produces a Windows NSIS installer (and MSI when the local WiX toolchain is available). The NSIS wizard supports choosing a per-user installation directory, so no administrator account is required by default. The installer bundles the Node runtime and the two Playwright packages used by the Worker; an installed copy does not depend on Node being present on `PATH`.

The app still requires Microsoft Edge and WebView2 on Windows. Login is performed manually in the dedicated headed Edge profile. The default mode is demo; live Tmall writes remain disabled unless a reviewed adapter contract and the explicit confirmation gate are present.

## Verification

```powershell
npm test
npm run build
npm run prepare:runtime
cargo check --manifest-path src-tauri/Cargo.toml
```

See [docs/product/PRD.md](docs/product/PRD.md), [docs/design/desktop-console.md](docs/design/desktop-console.md), and [docs/architecture/design.md](docs/architecture/design.md) for the product contract and safety boundaries.
