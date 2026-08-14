# Tmall publish local debugger bridge

Temporary unpacked Edge MV3 extension plus a dependency-free Node bridge. It only targets:

`https://sell.publish.tmall.com/tmall/publish.htm?id=828872681901`

## Start

1. Run `node edge-debug-bridge/bridge.mjs` from the project root.
2. In Edge, open `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select `edge-debug-bridge`.
3. Open or activate the exact target URL. The service worker attaches Chrome Debugger, enables Runtime/Page/Network, and polls the local bridge. The worker also uses a 30-second alarm and tab events to recover from MV3 suspension.

## Local API

- `GET http://127.0.0.1:19827/health`
- `POST /eval` with `{"tabId":123,"expression":"document.title"}`
- `POST /cdp` with `{"tabId":123,"method":"Page.getNavigationHistory","params":{}}`
- `GET /network?limit=200`
- `POST /network/clear`

`/eval` and `/cdp` wait up to 70 seconds for the extension's next poll. The extension sends events to its private `/events` transport endpoint; it is not required for normal local use.

The bridge binds only to loopback. The extension redacts authorization, cookie, CSRF, and proxy-authorization headers. Command execution is constrained to a read-only CDP allowlist; evaluations force `throwOnSideEffect` and reject obvious network, submission, click, navigation, storage, and cookie APIs. It intentionally does not expose input, navigation, DOM mutation, or submission commands.
