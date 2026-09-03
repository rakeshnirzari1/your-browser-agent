# Your Browser Agent — Operating Instructions for AI Agents

## What this is

A local relay + Chrome extension that lets you drive the user's **real,
logged-in Chrome browser**. You send simple JSON HTTP requests to a relay
running on the user's machine. The relay forwards them to the browser through
the extension. **You do not launch or install anything.** The user's logins,
cookies and profile all apply, so sites the user is signed into are already
authenticated for you.

## Always check health first

Before any browser work, send a GET request to `http://127.0.0.1:7799/status`.
If the response shows `"extension": true` you are good to go. If it shows
`false`, stop and tell the user: *"Please click the Your Browser Agent
extension icon and press Connect."* Do not proceed until it is `true`.

> If the relay is not on port 7799, ask the user which port they started it on
> (the extension popup shows the address), or check the relay's console output.

## How you send commands

Send a POST request to `http://127.0.0.1:7799/cmd` with a JSON body of two
fields: `cmd` (command name) and `params` (object of parameters). The response
is JSON: `ok: true` with a `result` on success, or `ok: false` with an
`error` message on failure.

Every command accepts an optional `tabId` inside `params`; if omitted it acts
on the tab the extension last used (usually the tab you opened or activated).

**Engine (v2):** the extension drives Chrome over the Chrome DevTools Protocol —
clicks, typing and key presses are **real trusted input events** (they pass
`isTrusted` checks, so form validation, autocomplete, dropdowns and payment
flows behave exactly as if a human did them), and `evaluate` runs in the
page's **main world** (it can see the page's own JavaScript variables and is
immune to page CSP). Speed options: pass `"waitUntil":"none"` on `goto`/
`newTab` to skip waiting for full load, `"includeText":false` on `snapshot`
to skip the text dump, and keep `maxNodes` small. A short, visible
"started debugging this browser" bar appears on the tab while the extension
is attached — it is what powers the trusted input; it disappears after
~2 minutes idle.

> **Known limitation:** actions target the top-level document. Elements inside
> `iframe`s are not clickable/fillable directly (snapshot won't list them) —
> use `evaluate` to reach into frames
> (`document.querySelector('iframe').contentDocument...`) for now.

## The core loop

1. **Snapshot** the page to get its interactive elements — each has a `ref`
   like `e1`, `e2`, plus a `role` and accessible `name`.
2. **Act** on an element using its `ref` with `click`, `fill` or `press`.
3. After any navigation, **snapshot again** — refs are invalidated when the
   page changes.

Repeat until the task is done. Always verify by snapshotting or evaluating
after each action.

## Available commands

| Command | Params | Returns |
| --- | --- | --- |
| `ping` | — | `{ pong: true, ts }` |
| `tabs` | — | list of `{ tabId, title, url, active }` |
| `newTab` | `url` | `{ tabId, url, title }` (waits for load) |
| `goto` | `url`, optional `tabId` | `{ tabId, url, title }` (waits for load) |
| `activate` | optional `tabId` | brings the tab to the front |
| `closeTab` | optional `tabId` | closes the tab |
| `snapshot` | optional `maxNodes` (default 100), `includeText` (default true) | `{ url, title, nodes, text }` |
| `click` | `selector`, optional `tabId` | `{ clicked, tag, name }` |
| `fill` | `selector`, `value`, optional `tabId` | `{ filled, method }` |
| `press` | `key`, optional `selector` | `{ pressed, tag }` |
| `evaluate` | `expression` (JS), optional `tabId` | the expression's value |
| `screenshot` | optional `format` (`png`/`jpeg`) | `{ data: <base64>, format }` |

**Keys for `press`:** `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`,
`ArrowUp/Down/Left/Right`, `Home`, `End`, `PageUp`, `PageDown`, `Space`, or a
single character.

## Selector syntax for `click`, `fill`, `press`

- A `ref` from the latest snapshot: `e25` or `@e25` — **preferred**
- `css=...` or a bare CSS selector: `css=button.save`
- `text=Sign in` — substring text match
- `text="Sign in"` — exact text match (single or double quotes)
- `role=button` — ARIA role (inferred for plain `button`, `a`, inputs)
- `role=button[name="Save"]` — role + accessible name

## Finding things on a page

Snapshot and inspect the `nodes` array for matching `role`/`name`. To read
arbitrary data, use `evaluate` with a JavaScript **expression** (an IIFE or
expression that returns a value, e.g. `document.title`,
`document.querySelector('h1').innerText`, or an `(() => {...})()` block).
The result must be JSON-serializable (no DOM nodes). For long lists, scroll
with `evaluate` (`window.scrollBy(0, 800)`) and snapshot again, repeating
until you have everything.

## Etiquette — this is the user's real browser

- Only touch what the task requires. **Do not** log out, change settings, or
  submit irreversible forms unless explicitly asked.
- Prefer `newTab` over navigating away from tabs the user already has open.
- After finishing, you may leave your tab open or `closeTab` it; tell the
  user what you left behind.
- If a command errors, snapshot to re-check page state rather than blindly
  retrying.

## Handling failures

- `ok: false` with *"no extension connected"* → tell the user to click the
  extension icon and press **Connect**, then retry.
- `ok: false` with *"selector matched nothing"* → snapshot again for fresh
  refs, or use another selector form.
- A navigation timeout → `evaluate` `location.href` to see where the page
  actually landed.
- Autocomplete-style fields (recipients, search suggestions): after `fill`,
  click the suggestion row (`role=option` containing the text) instead of
  pressing Enter — synthetic Enter often doesn't commit the selection.

## Example flow

1. `GET /status` → `extension: true`
2. `POST /cmd {cmd: "newTab", params: {url: "https://mail.google.com"}}`
3. `POST /cmd {cmd: "snapshot"}` → read refs
4. `POST /cmd {cmd: "click", params: {selector: "e3"}}` (or fill/press)
5. `POST /cmd {cmd: "snapshot"}` → verify the result
6. Report back: final URL, what you did, anything you extracted.
