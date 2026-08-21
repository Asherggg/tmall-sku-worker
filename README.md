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

The source worker defaults to **demo mode** for automated tests. The Windows v0.1.21 desktop UI exposes only live mode. A live item runs through OMS disablement, Doris material lookup, the two-phase SKU rebuild, and the guarded subsidy-template submission. The subsidy adapter defaults to authenticated MTop/OSS HTTP requests through the logged-in Edge context and retains `TMALL_SUBSIDY_TRANSPORT=page` as an explicit fallback. Creating a batch uses a single explicit confirmation dialog; users no longer select demo mode or type a confirmation phrase. Batch preview shows at most 10 products inside a fixed-height scroll area. Final SKU equivalence excludes live inventory because Tmall inventory can change independently during rebuild.

## Browser lifecycle

On Windows the worker starts the installed Edge with an application-owned `edge-profile-v2`. During login it does **not** launch or attach Playwright. After the user finishes login, `/browser/verify` attaches once through a fixed loopback CDP port and checks all Tmall/Taobao tabs. `/browser/hide` hides the same headed Edge window with Win32; it does not close the browser, create another process, or switch to headless mode. The profile remains under the worker data directory, and no cookies or tokens are written to the repository.

This v2 profile is intentionally separate from the earlier Playwright-launched profile. If a page enters a repeated risk challenge, stop retrying and leave the old profile untouched; repeated challenge attempts are not automated.

## Windows installer

`npm run tauri:build` produces a Windows NSIS installer (and MSI when the local WiX toolchain is available). The NSIS wizard supports choosing a per-user installation directory, so no administrator account is required by default. The installer bundles the Node runtime and the two Playwright packages used by the Worker; an installed copy does not depend on Node being present on `PATH`.

The app still requires Microsoft Edge and WebView2 on Windows. Login is performed manually in the dedicated headed Edge profile. Starting with v0.1.7, the browser is only an authenticated session container after verification. The Worker reads the server bootstrap with HTTP GET, calls sale-property preview with HTTP POST, submits both rebuild phases directly to `/tmall/submit.htm`, and polls the server bootstrap for readback. It does not evaluate page code, mutate `GlobalStore`, emit a submit button event, reload, or navigate the page during a task. Login opens the seller workbench at `myseller.taobao.com` by default; `TMALL_LOGIN_URL` can override it.

Live execution remains fail-closed. A CAPTCHA/risk page, invalid channel value, local validation error, HTTP/business error, unknown submit response, ID mismatch, or field mismatch moves the task to `needs_manual_review` and is never blindly retried.

Before upgrading, exit the older desktop process so it releases loopback port `19828`. The v0.1.21 UI checks the connected Worker version and disables live mode when an older Worker, missing Doris configuration, or disabled subsidy contract is still running. Runtime workflow settings are read from the app data file `runtime-config.json`, so they do not depend on the environment inherited by Explorer. See [the v0.1.21 release notes](docs/release/0.1.21.md) for the authenticated subsidy API contract, verified live import and readback evidence, and fallback mode.

## Verification

```powershell
npm test
npm run build
npm run prepare:runtime
cargo check --manifest-path src-tauri/Cargo.toml
```

See [docs/product/PRD.md](docs/product/PRD.md), [docs/design/desktop-console.md](docs/design/desktop-console.md), and [docs/architecture/design.md](docs/architecture/design.md) for the product contract and safety boundaries.
