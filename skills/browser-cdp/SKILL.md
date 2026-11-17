---
name: browser-cdp
description: Verify, debug, and drive real web pages through Chrome DevTools Protocol with the `web_inspect` and `browser` tools — headless render checks, @eN accessibility snapshots and diffs, clicks/forms, screenshots, console and network errors, and attaching to the user's running Chrome. Use when a task involves checking a web UI, a local dev server, a deployed URL, a login or form flow, or browser-only bugs.
---

# Browser automation with pi-cdp

Two tools, one Chrome DevTools Protocol engine (system Chrome, Edge, Chromium, or Brave — no Playwright download).

## Pick the right tool

| Need | Tool |
| --- | --- |
| "Does this page render? Any JS errors or broken requests? What does it look like?" | `web_inspect` (one call, isolated headless browser, auto-closed) |
| Click, fill forms, log in, multi-step flows, multiple tabs, keep state between calls | `browser` |
| Work inside the user's own logged-in Chrome | `browser` action `attach` |

Start with `web_inspect` after UI edits or deploys. Move to `browser` as soon as you need to interact.

## `web_inspect` — one-shot health check

```json
{ "url": "http://localhost:5173", "screenshot": true }
```

- Accepts full URLs, bare hosts (`example.com` → https), `localhost:3000` (→ http), and local `.html` paths.
- Returns HTTP status, a health line (page errors / failed requests / console warnings), the @eN snapshot, and the image when `screenshot: true`.
- Use `wait_for_selector`, `wait_for_text`, or `wait_ms` for client-rendered apps that paint after `load`.
- Only request `screenshot` when layout or visuals matter; the text snapshot is far cheaper.

## `browser` — the snapshot → act → diff loop

1. `{"action": "open", "url": "https://app.local/login"}` — auto-launches headless session `b1`, tab `t1`, and returns a snapshot.
2. Read refs from the snapshot, e.g. `@e4 textbox "Email"`, `@e6 button "Sign in"`.
3. Act on refs:
   - `{"action": "fill", "target": "@e4", "value": "me@example.com"}`
   - `{"action": "click", "target": "@e6"}`
   - `{"action": "select", "target": "@e9", "values": ["EU"]}`
   - `{"action": "type", "text": "query", "submit": true}` / `{"action": "press", "key": "Escape"}`
4. Every interaction waits for the page to settle and returns a **diff** (added / changed refs). When the document changes (new URL), the full new snapshot is returned instead.
5. Repeat. Call `{"action": "snapshot"}` for the full tree, or `{"action": "snapshot", "diff": true}` for changes only.

Rules:
- Refs are tied to a document generation. After a navigation, old `@eN` refs are rejected — use the refs from the newest snapshot.
- CSS selectors also work as `target` when no ref fits (`"target": "#submit"`).
- Large pages: narrow with `root_selector`, or raise `max_elements` / `max_chars`; `include_static_text: true` adds plain text lines.
- Pass `snapshot: false` on an interaction when you will take a snapshot or screenshot right after anyway.

## Waiting, evaluating, and diagnosing

- `{"action": "wait", "selector": ".toast"}` · `"text": "Saved"` · `"url_includes": "/dashboard"` · `"network_idle_ms": 500` · `"delay_ms": 1000`.
- `{"action": "evaluate", "expression": "document.querySelectorAll('li').length"}` — promises are awaited; exceptions come back as errors.
- `{"action": "console"}` — page errors, console messages, and auto-handled dialogs.
- `{"action": "network", "failed_only": true}` — failed and HTTP ≥ 400 requests with method, URL, and error text.
- Check `console` and `network` before guessing why a page is blank or broken.

## Screenshots

- `{"action": "screenshot"}` attaches the viewport image; add `"full_page": true`, `"target": "@e12"` for one element, or `"save_path": "shots/home.png"` to keep a file.
- `{"action": "viewport", "width": 390, "height": 844, "mobile": true, "device_scale_factor": 3}` for responsive checks.

## Tabs and sessions

- `new_tab` (optional `url`), `tabs`, `switch_tab` (`tab_id: "t2"`), `close_tab`; popups opened by the page are adopted as new tabs automatically.
- `launch` starts another session (`b2`): `headless: false` for a visible window, `user_data_dir` for a persistent profile, `executable_path` for a specific browser.
- `sessions` lists everything; `switch_session` changes the default; most actions accept `session_id` / `tab_id`.
- `back`, `forward`, `reload` re-snapshot the page.
- JavaScript `alert` / `confirm` / `prompt` are answered automatically (default dismiss) so they never hang a call; change with `{"action": "dialog_policy", "policy": "accept"}`.

## Attaching to the user's Chrome

Use only when the user asks to work in their real browser (existing logins, extensions, open tabs).

1. The user enables remote debugging: recent Chrome via the toggle at `chrome://inspect/#remote-debugging`, or by starting Chrome with `--remote-debugging-port=9222` and a dedicated `--user-data-dir`.
2. `{"action": "doctor"}` (or `/cdp doctor`) shows detected browsers and live endpoints.
3. `{"action": "attach"}` auto-selects the live endpoint; or pass `port`, `host`, or `ws_url`. Chrome may show an approval prompt the user must accept.
4. `{"action": "disconnect"}` detaches only; the user's browser and tabs stay open. Never close tabs you did not open in an attached session without asking.

## Cleanup

Sessions close automatically when the Pi session ends. `/cdp stop` (or `browser` action `disconnect` with `all: true`) closes them now; `/cdp` shows current sessions.
