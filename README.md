# pi-cdp

Zero-dependency native **Chrome DevTools Protocol (CDP)** browser automation, `@eN` accessibility snapshots, visual screenshots, and live Chrome attach for [Pi](https://pi.dev).

Built directly on Node.js `>=22.18` built-in `WebSocket` — **0 runtime npm dependencies**, **no background daemon**, **no MCP bridge**, **no manual browser downloads**, and a **fixed session tool list** that never invalidates your LLM prompt cache.

## Why `pi-cdp`?

| Capability | `pi-cdp` | Playwright / MCP wrappers | Daemon / extension bridges |
| --- | --- | --- | --- |
| **Runtime npm dependencies** | **0** | Heavy (`playwright`, `@modelcontextprotocol/sdk`) | Multiple (`ws`, `tsx`, `yaml`, etc.) |
| **Browser setup** | **Zero-config auto-discovery** (Chrome, Edge, Brave, Chromium, Playwright cache) | Version-pinned browser download (`npx playwright install`) | Manual unpacked extension or `/browser-setup` |
| **Element targeting** | **`@e1`, `@e2` Accessibility Tree refs** + snapshot diffs + CSS fallback | Snapshot or selector | Varies |
| **Prompt-cache stability** | **Fixed 2-tool surface (`web_inspect`, `browser`)** | Dynamic/lazy tool mutations break cache | Mid-session auth expiry mutates tools |
| **Live user Chrome attach** | **Yes** (`DevToolsActivePort` / `--remote-debugging-port`, non-destructive detach) | Usually isolated profile only | Consent / daemon socket issues |
| **Cross-platform CI** | **macOS + Linux + Windows** real Chrome e2e | Often Linux/macOS only | Often POSIX-only |

## Install

```bash
pi install npm:pi-cdp
```

Or from GitHub:

```bash
pi install git:github.com/yiyabo/pi-cdp
```

## Tools Provided

### 1. `web_inspect` — One-Shot Self-Cleaning Page Probe

Launches an isolated headless browser, renders any SPA or local dev server URL, captures a token-compact `@e1..@eN` accessibility snapshot, collects JS console errors, uncaught page exceptions, and failed network requests, optionally attaches a real visual PNG screenshot (`ImageContent`), and tears down the browser process tree cleanly.

```json
{
  "url": "http://localhost:3000",
  "waitForSelector": "main",
  "screenshot": true
}
```

### 2. `browser` — Multi-Session, Multi-Tab Interactive CDP Controller

Full interactive browser control with zero-ceremony lazy launch (`browser({ action: "open", url: "..." })` auto-starts a headless session if none is active):

- **Discovery & lifecycle**: `doctor`, `sessions`, `switch_session`, `launch`, `attach`, `disconnect`
- **Navigation & history**: `open`, `navigate`, `reload`, `back`, `forward`, `wait`
- **Multi-tab management**: `tabs`, `new_tab`, `switch_tab`, `close_tab`
- **Perception**: `snapshot` (with `@e1`, `@e2` interactive refs + `diff: true` incremental mode), `screenshot` (viewport, full-page via layout metrics, or single `@eN` element crop)
- **Actions**: `click` (with automatic scroll-into-view and double-click support), `fill` (React/Vue/ContentEditable safe), `select` (single & multi `<select>`), `hover`, `type`, `press`, `scroll`, `viewport`, `dialog_policy`
- **Runtime diagnostics**: `console` (console logs + uncaught exceptions), `network` (HTTP status + failed requests), `evaluate` (async JS expression evaluation)

### 3. `/cdp` Slash Command & TUI Status

- `/cdp` or `/cdp status` — inspect active browser sessions and tabs
- `/cdp doctor` — list discovered local browsers, Playwright caches, and live attachable Chrome endpoints
- `/cdp stop` — close all active browser sessions immediately

## Attaching to Your Running Chrome

`pi-cdp` supports two ways to attach non-destructively to your own Chrome session (`disconnect` detaches CDP without closing your browser):

1. **Chrome 144+ Remote Debugging Toggle**:
   Open `chrome://inspect/#remote-debugging` in Chrome and enable remote debugging, then call `browser({ action: "attach" })` and click **Allow** on Chrome's prompt.
2. **Explicit Debug Port Profile**:
   Launch Chrome with `--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-dev` and call `browser({ action: "attach", port: 9222 })`.

Note: `/cdp doctor` checks port liveness over plain TCP + HTTP `/json/version` without opening a WebSocket, so running `doctor` never triggers unwanted approval popups in Chrome.

## Configuration Overrides (Optional)

Zero config is needed on standard macOS, Linux, or Windows setups. When needed, override binary selection via:

- Environment variables: `PI_CDP_EXECUTABLE`, `CHROME_BIN`, `PUPPETEER_EXECUTABLE_PATH`, `PI_CDP_PORT`
- Project or user config: `.pi/cdp.json` or `~/.pi/agent/cdp.json` (`{ "executablePath": "/path/to/chrome" }`)

## License

MIT
