# Tmall SKU Worker Agent Guide

## Project Shape

- `src/` is the Vue 3 + TypeScript + Vite console.
- `worker/` is the local Node.js HTTP worker. It owns the application Edge profile, browser lifecycle, task queue, and audit records.
- `src-tauri/` is the Tauri 2 Rust host. Keep desktop lifecycle and native Windows behavior here; keep product logic in the UI or worker.
- `tests/` contains the worker integration tests. `docs/product/PRD.md` is the product contract; `docs/architecture/design.md` is the system and browser-boundary contract; `docs/design/desktop-console.md` is the UI contract; `docs/qa/verification.md` is the acceptance checklist.
- `edge-debug-bridge/` is a loopback-only, read-only CDP bridge. Preserve its command allowlist and redaction behavior.

Read the relevant contract before changing that area. Update the contract when a behavior change is intentional rather than silently drifting implementation and documentation apart.

## Working Rules

1. Inspect the current process, browser, filesystem, and task state before changing them. Treat `.runtime/` as local state, not source data.
2. Use the existing TypeScript/Vue/Node/Tauri patterns and keep changes scoped to the requested behavior. Use CodeGraph only when a `.codegraph/` index exists; otherwise use `rg` for literal text and normal source inspection for structure.
3. Keep login human-driven in the dedicated headed Edge profile. Attach Playwright/CDP only after the user has completed login; preserve the profile and keep `navigator.webdriver === false` as a verification signal. Risk challenges remain user-handled, and automation resumes only after successful verification.
4. The default execution mode is `demo`. Any live Tmall write requires an explicit confirmation gate, a complete pre-write snapshot, a reviewed adapter contract, and post-write readback. Use the two-phase temporary-identity then restore workflow described in the architecture document. An unknown response or field mismatch becomes `needs_manual_review`; do not blindly retry a write.
5. Keep cookies, tokens, signatures, authorization headers, and full request bodies out of source, commits, and audit exports. Redact network evidence and store generated runtime artifacts under `.runtime/`.
6. For batch work, group operations by `itemId`, process one item at a time, preserve the original SKU snapshot, and verify the exact SKU count and business fields before reporting success.
7. Treat `scripts/cdp-*` as targeted diagnostics: inspect the script before running it because some scripts are item-specific and can click or submit. Run them only for an explicitly scoped task.
8. Use concise comments only for non-obvious protocol or safety decisions. Avoid unrelated refactors and generated-file churn.

## Commands

```powershell
npm install
npm run dev
npm run worker
npm run prepare:runtime
npm run tauri:dev
npm run tauri:build
```

## Verification

Run the narrowest relevant checks, then the full baseline for cross-layer changes:

```powershell
npm test
npm run build
npm run prepare:runtime
cargo check --manifest-path src-tauri/Cargo.toml
```

For browser changes, verify the dedicated Edge process/profile, CDP connection, login state, risk state, `webdriver`, visibility, and same-tab URL before and after the operation. Never claim a live change without a successful server readback.

## Versioning

- Every distributed update must increment the patch version by exactly `0.0.1` (for example, `0.1.3` -> `0.1.4`). Never distribute changed code under an existing version number.
- Before packaging, synchronize the version across `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, Worker/UI version constants, and release documentation.
- Complete the release only after the installer filename and installed Worker `/health` version both match the new version.

## Git Hygiene

- The repository's primary branch is `main`.
- Stage only files belonging to the requested change; inspect `git status --short` before committing.
- Keep `.runtime/`, `.playwright-cli/`, `node_modules/`, `dist/`, `logs/`, and `src-tauri/target/` untracked through `.gitignore`.
- Treat `src-tauri/target/` and bundled release copies as build output; regenerate them from source instead of editing them by hand.
- Commit messages should state the behavior changed and remain small enough to review.
