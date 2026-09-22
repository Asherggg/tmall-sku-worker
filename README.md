# Tmall Operations Workbench

Tauri 2 + Vue 3 operations desktop with a local Node/Playwright worker. The shell behaves like a compact Windows desktop: operators launch installed modules from desktop shortcuts, switch running modules from the taskbar, and share one authenticated Tmall session, task service, and audit boundary.

The installed applications are **SKU ID 重建** and **新增花型**. SKU rebuild keeps its two-phase console inside a persistent workbench window. Add Pattern accepts an `.xlsx` list of explicit `规格 + 颜色分类` combinations, preserves every online SKU and existing SKU ID, and submits at most once per product only when a listed combination is absent. Minimizing or closing either module view does not stop Worker tasks or discard its in-session draft.

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

The source worker defaults to **demo mode** for automated tests. The Windows v0.1.29 desktop UI exposes live mode inside both applications. SKU rebuild snapshots the current item, obtains replacement SKU IDs through a temporary unique specification, restores the original business fields, and verifies the final state. Add Pattern reads the authenticated Tmall bootstrap, validates every workbook row against the online model, keeps matching combinations unchanged, and adds only explicitly listed missing combinations. Existing combinations complete with zero POST requests; a product with additions uses one serialized `/tmall/submit.htm` request and strict final server readback. Batches run at most two different item pipelines at once, while all Tmall submit requests remain serialized by the Worker write lock. Stock is platform-managed and excluded from final equivalence; SKU identities and all other business fields remain strict.

## Workbench shell

The first screen is the operations desktop rather than an application console. Double-click `SKU ID 重建` or `新增花型` to open an independent persistent application window; `任务中心` and `浏览器会话` open the corresponding SKU views. The workbench provides minimize, maximize, restore, close, drag, resize, taskbar switching, global Worker/login status, and task/review badges. Hidden modules stay mounted so drafts and navigation state remain intact; the Worker remains the owner of long-running task state.

## Browser lifecycle

On Windows the worker starts the installed Edge with an application-owned `edge-profile-v2`. During login it does **not** launch or attach Playwright. After the user finishes login, `/browser/verify` attaches once through a fixed loopback CDP port and checks all Tmall/Taobao tabs. `/browser/hide` hides the same headed Edge window with Win32; it does not close the browser, create another process, or switch to headless mode. The profile remains under the worker data directory, and no cookies or tokens are written to the repository.

This v2 profile is intentionally separate from the earlier Playwright-launched profile. If a page enters a repeated risk challenge, stop retrying and leave the old profile untouched; repeated challenge attempts are not automated.

## Windows installer

`npm run tauri:build` produces a Windows NSIS installer (and MSI when the local WiX toolchain is available). The NSIS wizard supports choosing a per-user installation directory, so no administrator account is required by default. The installer bundles the Node runtime and the two Playwright packages used by the Worker; an installed copy does not depend on Node being present on `PATH`.

The app still requires Microsoft Edge and WebView2 on Windows. Login is performed manually in the dedicated headed Edge profile. Starting with v0.1.7, the browser is only an authenticated session container after verification. The Worker reads the server bootstrap with HTTP GET, uses a model-stream optimization for read-only polling when available, calls sale-property preview with HTTP POST, submits both rebuild phases directly to `/tmall/submit.htm`, and polls the server bootstrap for readback. It does not evaluate page code, mutate `GlobalStore`, emit a submit button event, reload, or navigate the page during a task. Login opens the seller workbench at `myseller.taobao.com` by default; `TMALL_LOGIN_URL` can override it.

Live execution remains fail-closed. A CAPTCHA/risk page, unsupported sales property, local validation error, HTTP/business error, unknown submit response, ID mismatch, or field mismatch moves the task to `needs_manual_review` and is never blindly retried. A legacy or empty `channelOption` stops before every preview or submit POST; the operator must explicitly choose a currently offered `1` (纯电商) or `2` (商场同款) value for that task, and the Worker rechecks the fresh bootstrap before continuing.

Before upgrading, exit the older desktop process so it releases loopback port `19828`. The v0.1.29 NSIS installer also stops any orphaned bundled Worker whose executable path is inside the target installation directory before replacing `runtime\\node.exe`; the Edge window and Profile are left intact. The Tauri host places its bundled Node Worker in a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so a normal or abnormal host exit does not leave the Worker holding the runtime file while Edge processes launched later remain outside the Job. The v0.1.29 UI checks the connected Worker version before enabling live mode. The installed application requires only the dedicated Taobao/Tmall login; it contains no workflow credential or external-system configuration. The technical package identity remains `Tmall SKU Worker` so existing installations and application data upgrade in place. See [the v0.1.29 release notes](docs/release/0.1.29.md).

## Verification

```powershell
npm test
npm run build
npm run prepare:runtime
cargo check --manifest-path src-tauri/Cargo.toml
```

See [docs/product/PRD.md](docs/product/PRD.md), [docs/design/desktop-console.md](docs/design/desktop-console.md), and [docs/architecture/design.md](docs/architecture/design.md) for the product contract and safety boundaries.
