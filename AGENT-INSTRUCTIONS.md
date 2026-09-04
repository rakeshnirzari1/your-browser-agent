# Your Browser Agent — Operating Instructions for AI Agents

*Paste this file (or point your agent at it) to let it drive the user's real Chrome.*

## What this is

A local relay + Chrome extension that lets you drive the user's **real,
logged-in Chrome browser**. You send simple JSON HTTP requests to a relay
running on the user's machine (`http://127.0.0.1:7799`). The relay forwards
them to the browser through the extension. **You do not launch or install
anything** — the user's logins, cookies, extensions and profile all apply, so
sites they are signed into are already authenticated for you.

Everything stays on the user's machine (`127.0.0.1`). No cloud, no accounts.

## Always check health first

Before any browser work, send:

```
GET http://127.0.0.1:7799/status
```

If the response shows `"extension": true` you are good to go. If it shows
`false`, stop and tell the user: *"Please click the Your Browser Agent
extension icon and press Connect (or just open its popup)."* Then poll
`/status` every ~2 seconds until it flips to `true` — do not retry commands
against a disconnected relay.

> If the relay is not on port 7799, ask the user which port they started it on
> (the extension popup shows the address), and use that port everywhere below.

## How you send commands

`POST http://127.0.0.1:7799/cmd` with a JSON body:

```json
{ "cmd": "click", "params": { "selector": "e3" } }
```

Responses: `{ "ok": true, "result": ... }` or `{ "ok": false, "error": "..." }`.

Every command accepts an optional `tabId`; omit it to act on the tab the
extension last used. Most commands also accept an optional `frame` (see
*Frames & iframes* below). Commands that act on a tab take an optional
`timeoutMs` (navigation waits default to 30 s).

**Engine:** the extension drives Chrome over the Chrome DevTools Protocol —
clicks, typing and key presses are **real trusted input events** (`isTrusted`
is true: form validation, autocomplete, dropdowns, payment flows and captcha
handlers behave exactly as if a human did them), and `evaluate` runs in the
page's **main world** (it sees the page's own JavaScript variables and is
immune to page CSP). While a tab is being driven a brief *"started debugging
this browser"* bar may appear — that is what powers the trusted input; it
auto-detaches after ~2 minutes idle.

Speed options: `"waitUntil": "none"` on `goto`/`newTab`/`reload` skips waiting
for full load; `"includeText": false` and a small `"maxNodes"` on `snapshot`
keep responses small.

## The core loop

1. **`snapshot`** the page → every interactive element gets a `ref` like `e1`,
   plus `role`, `name` (aria-label/placeholder/text), `tag` and a `selector`.
2. **Act** with `click`, `fill`, `press`, `hover`, `upload`, ... using the `ref`
   or any selector form.
3. After anything changes the page, **snapshot again** — refs are invalidated
   by navigation and DOM changes.
4. **Verify** after each important action (snapshot, `evaluate`, or
   `waitFor`). Never assume a click landed; check its effect.

## Command reference

| Command | Params | Returns / notes |
| --- | --- | --- |
| `ping` | — | `{ pong: true, engine }` — liveness check |
| `tabs` | — | list of `{ tabId, title, url, active, windowId }` |
| `newTab` | `url` | opens a fresh tab (leaves the user's tabs alone); returns `{ tabId, url, title }` |
| `goto` | `url`, `tabId?` | navigate an existing tab |
| `activate` | `tabId?` | bring a tab to the front and focus its window |
| `closeTab` | `tabId?` | close the tab you opened |
| `reload` | `ignoreCache?` | reload the current page |
| `back` / `forward` | — | history navigation; `{ navigated, url }` |
| `snapshot` | `maxNodes?` (100), `includeText?` (true), `frame?` | `{ url, title, nodes[], text }` |
| `frames` | — | list of `{ index, frameId, url, crossOrigin, reachable, selector }` (0 = main frame) |
| `click` | `selector`, `frame?`, `method?` (`"js"`), `button?`, `double?`, `point?` (cross-origin frames) | trusted pointer click at the element's centre (auto-scrolls, avoids covered points) |
| `hover` | `selector`, `frame?` | real pointer move (opens hover menus, tooltips) |
| `fill` | `selector`, `value`, `frame?`, `method?` | types into inputs/textareas/contenteditable; checks checkboxes/radios; selects `<option>` by value **or visible label** |
| `type` | alias of `fill` | same |
| `selectOptions` | `selector`, `frame?` | list a `<select>`'s options `{ value, label, index, selected }` |
| `press` | `key`, `modifiers?` (`["Control","Shift","Alt","Meta"]`), `selector?`, `frame?` | send a key or shortcut (e.g. `Control+A`) |
| `evaluate` | `expression` (JS), `frame?` | run JS in the page's main world; must return a JSON-serializable value |
| `waitFor` | one of `expr` / `text` / `selector` / `urlContains` / `dialogGone`, `timeoutMs?` (30 s), `frame?` | polls until true, then `{ matched, waitedMs }` |
| `scroll` | `direction?` (`down`/`up`), `amount?`, or `x`/`y`, or `selector` | scroll the page/frame or bring an element into view |
| `upload` | `selector`, `files` (absolute path or array), `frame?` | attach real files to an `<input type="file">` (fires change) |
| `screenshot` | `format?` (`png`/`jpeg`), `fullPage?`, `quality?` | `{ data: <base64>, format }` |
| `pdf` | `printBackground?`, `landscape?`, `scale?` | `{ data: <base64 PDF> }` — save the current page as PDF |
| `dialog` | `accept` (bool), `promptText?` | answer an open `alert()`/`confirm()`/`prompt()` |

### Keys for `press`

`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Insert`, `Home`, `End`,
`PageUp`, `PageDown`, `ArrowUp/Down/Left/Right`, `F1`–`F12`, `Space`, single
characters (typing a plain character sends real key events), or a character
with `modifiers`. Shortcut example: select-all + copy:

```json
{ "cmd": "press", "params": { "key": "a", "modifiers": ["Control"] } }
{ "cmd": "press", "params": { "key": "c", "modifiers": ["Control"] } }
```

The clipboard itself lives on the user's machine — read it with your own OS
clipboard tool, or for an input's content just `evaluate`
`document.activeElement.value` / `window.getSelection().toString()` after
copying.

## Selector syntax for `click`, `fill`, `press`, `hover`, `upload`, ...

- `e25` or `@e25` — a `ref` from the latest snapshot (**preferred**; re-snapshot after any change)
- `css=button.save` or a bare CSS selector — `#id`, `.class`, `[attr=...]`
- `text=Sign in` — substring text match on links/buttons/labels
- `text="Sign in"` — exact text match (single or double quotes)
- `role=button`, `role=textbox`, `role=link` ... — ARIA role (inferred for plain elements)
- `role=button[name="Save"]` — role + accessible name

Selectors are evaluated inside the chosen `frame` (main frame by default).
They work with the *visible, interactive* element model — hidden/`display:none`
elements are skipped by snapshots.

## Frames & iframes (important)

Run `frames` to see them:

```json
{ "frames": [
  { "index": 0, "frameId": "…", "url": "https://site.com/",        "crossOrigin": false, "reachable": true },
  { "index": 1, "frameId": "…", "url": "https://site.com/pay",     "crossOrigin": false, "reachable": true, "selector": "[id=\"pay\"]" },
  { "index": 2, "frameId": "…", "url": "https://3rdparty.com/…",   "crossOrigin": true,  "reachable": false, "selector": "[id=\"captcha\"]" }
]}
```

- **Same-origin frames** (`reachable: true`) are fully supported: pass
  `"frame": 1`, a `frameId`, a URL substring, or the iframe's main-document
  selector. Then `snapshot`, `click`, `fill`, `evaluate`, `scroll`, `waitFor`,
  `press`, `selectOptions` all operate inside that frame.
- **Cross-origin frames** (`crossOrigin: true` — most third-party embeds,
  payment widgets, captcha iframes) cannot be *read or scripted*: Chrome's
  extension debugger API cannot reach out-of-process frames. Do NOT try to
  snapshot/fill/evaluate inside them — you will get a clear error.
- **But trusted clicks DO work into cross-origin frames.** Pointer events are
  hit-tested by the browser and routed into the frame's own process. Click a
  known point inside the frame's box with `point` as pixel offsets (`x`,`y`) or
  box fractions (`fx`,`fy`, default centre):

```json
{ "cmd": "click", "params": { "frame": "[id=\"captcha\"]", "point": { "fx": 0.5, "fy": 0.5 } } }
```

The frame box is auto-scrolled into view first. Locate the point from a
`screenshot` when you are not sure.

### Captchas

- Invisible captchas (reCAPTCHA v3, Turnstile managed, ...) need nothing — just
  continue; the site scores the session.
- Checkbox captchas: `frames` → click the checkbox by coordinates (above).
- Image/audio challenges cannot be solved by this extension (no reading of
  cross-origin frames). **Ask the user to solve it**, then `waitFor` the
  challenge to disappear (e.g. `"text"` or `"urlContains"` of the page state)
  or `screenshot` to confirm, and carry on.

## Typical flows

**Fill a login form and submit**

1. `newTab` / `goto` the URL
2. `snapshot` → pick refs
3. `fill` each field → `fill {selector, value}`
4. `click` the submit button (trusted input) — or `press {key:"Enter"}`
5. `waitFor {urlContains: "dashboard"}` or snapshot to verify

**Choose from a custom (non-native) dropdown**

1. `click` the combobox → `snapshot` (the popup options now have refs)
2. `click` the option by text (`text=Australia` or `role=option[name="Australia"]`)
   — avoid pressing Enter on autocomplete fields; click the suggestion row.

**Answer a dialog the page opened**

While an `alert()`/`confirm()`/`prompt()` is open, other commands return a
clear *"a JavaScript dialog is open"* error. Respond with:

```json
{ "cmd": "dialog", "params": { "accept": true } }
{ "cmd": "dialog", "params": { "accept": true, "promptText": "Agent Smith" } }
```

`beforeunload` dialogs are auto-accepted so navigations don't hang.

**Upload a file**

```json
{ "cmd": "upload", "params": { "selector": "input[type=file]", "files": ["C:/path/to/cv.pdf"] } }
```

`files` are paths on the user's machine. Prefer forward slashes on Windows.

**Wait for something to appear / change**

```json
{ "cmd": "waitFor", "params": { "selector": ".toast-success", "timeoutMs": 15000 } }
{ "cmd": "waitFor", "params": { "text": "Order confirmed" } }
{ "cmd": "waitFor", "params": { "expr": "document.querySelectorAll('tr.row').length > 10" } }
```

**Read a long list / infinite page** — loop: `evaluate window.scrollBy(0, 900)`,
`waitFor`/snapshot, repeat; or `scroll {direction:"down", amount:800}`.

**Copy something** — select (click into the field, `press Control+A`) then
`press Control+C`; read the OS clipboard with your own tools, or for input
values: `evaluate document.activeElement.value`.

**Save the page as PDF** — `pdf` returns base64; decode it to a file.

## Etiquette — this is the user's real browser

- Only touch what the task requires. **Do not** log out, change settings, or
  submit irreversible forms unless explicitly asked.
- Prefer `newTab` over navigating away from tabs the user has open. Keep track
  of which tab you created and close it when done (`closeTab {tabId}`).
- After finishing, report: the final URL, what you did, anything you left open.
- The "started debugging" bar on the active tab is expected; it disappears
  after ~2 minutes idle.

## Handling failures

- `"extension": false` at `/status`, or `ok:false` *"no extension connected"*
  → Chrome suspended the idle extension worker (normal in MV3). Ask the user to
  open the extension popup (or just wait ~30 s — it reconnects automatically),
  re-check `/status`, then retry.
- `"selector matched nothing"` → re-`snapshot` for fresh refs or use another
  selector form.
- `"a JavaScript dialog is open"` → run `dialog` first.
- Navigation timeout → `evaluate location.href` to see where the page landed;
  the page may be slow (raise `timeoutMs`) or a `beforeunload` dialog may have
  been pending (auto-accepted).
- A trusted click "did nothing" → the element may be covered or the handler
  async: re-snapshot, or retry with `"method": "js"` (synthetic click), or
  `waitFor` the expected effect instead of assuming.
- Cross-origin frame errors → read the *Frames & iframes* section above.
- Command stuck > ~30 s → the page may be busy or frozen; cancel and retry with
  a fresh snapshot. If a dialog opened mid-action, resolve it with `dialog`.

## Example flow (end to end)

1. `GET /status` → `extension: true`
2. `POST /cmd` `{cmd:"newTab", params:{url:"https://mail.google.com"}}`
3. `POST /cmd` `{cmd:"snapshot"}` → read refs/roles/names
4. `POST /cmd` `{cmd:"fill", params:{selector:"e2", value:"hello"}}`
5. `POST /cmd` `{cmd:"click", params:{selector:"e5"}}`
6. `POST /cmd` `{cmd:"snapshot"}` → verify the result changed
7. Report back: final URL, what you did, what you extracted, anything left open.
