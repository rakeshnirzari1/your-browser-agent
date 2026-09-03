/* Your Browser Agent v2 — MV3 service worker.
 * Drives the user's real Chrome over the Chrome DevTools Protocol (debugger
 * API): one persistent session per active tab, page helpers installed once,
 * trusted CDP input events. Fast, CSP-proof, main-world evaluate.
 * Agents talk to the local relay (HTTP) which forwards commands here. */

"use strict";

const DEFAULT_RELAY_URL = "ws://127.0.0.1:7799/ext";
const STORE_KEY = "ybaRelayUrl";
const HEARTBEAT_ALARM = "yba-heartbeat";
const HELPER_VERSION = 2;

let ws = null;
let connected = false;
let lastTabId = null;
let reconnectTimer = null;
let lastActivity = Date.now();

// one attached debugger session at a time (the tab currently being driven)
let dbg = null; // { tabId, attachedAt }

/* ------------------------------ page helper --------------------------------
 * Installed once per page load into the MAIN world via Runtime.evaluate.
 * Only this needs to change when behaviour evolves; commands below just call
 * into __ybaDriver. Self-contained: no closure over extension scope. */
const INSTALL_SRC = `(() => {
  if (window.__ybaDriver && window.__ybaDriver.v === ${HELPER_VERSION}) return true;
  const CLICKABLES = 'a[href], button, input:not([type="hidden"]), select, textarea, [role], summary, [contenteditable="true"], h1, h2, h3, h4, h5';
  function resolve(sel) {
    const s = String(sel).trim();
    if (!s) return null;
    let m = s.match(/^@?(e\\d+)$/);
    if (m) return document.querySelector('[data-ybaref="' + m[1] + '"]');
    m = s.match(/^text=(?:'([^']*)'|"([^"]*)")\\s*$/);
    if (m) { const w = m[1] != null ? m[1] : m[2]; for (const el of document.querySelectorAll(CLICKABLES)) if ((el.textContent || '').trim() === w) return el; return null; }
    m = s.match(/^text=(.+)$/);
    if (m) { const w = m[1].trim(); for (const el of document.querySelectorAll(CLICKABLES)) if ((el.textContent || '').includes(w)) return el; return null; }
    m = s.match(/^role=([\\w-]+)(?:\\[name=(?:'([^']*)'|"([^"]*)")\\])?\\s*$/);
    if (m) {
      const wr = m[1], wn = m[2] != null ? m[2] : m[3];
      for (const el of document.querySelectorAll('[role="' + wr + '"], button, a[href], input, select, textarea, [contenteditable="true"]')) {
        const role = el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' : (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? 'textbox' : el.tagName === 'SELECT' ? 'combobox' : '');
        if (role !== wr) continue;
        if (wn == null) return el;
        const name = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.value !== undefined ? String(el.value) : '') || (el.textContent || '').trim()).trim();
        if (name === wn) return el;
      }
      return null;
    }
    const css = s.startsWith('css=') ? s.slice(4) : s;
    try { return document.querySelector(css); } catch (_) { return null; }
  }
  function tagInfo(el) {
    let role = el.getAttribute('role') || '';
    if (!role) role = el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button'
      : el.tagName === 'INPUT' ? (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox')
      : el.tagName === 'TEXTAREA' ? 'textbox' : el.tagName === 'SELECT' ? 'combobox' : el.isContentEditable ? 'textbox' : '';
    return { ref: el.getAttribute('data-ybaref'), role, tag: el.tagName };
  }
  const driver = {
    v: ${HELPER_VERSION},
    snapshot(maxNodes, includeText) {
      const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [role="option"], [role="searchbox"], [role="listbox"], [role="spinbutton"], [role="slider"], [role="switch"], [role="heading"], [contenteditable="true"], summary';
      const els = [];
      document.querySelectorAll(sel).forEach((el) => {
        if (el.closest('[aria-hidden="true"]')) return;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        els.push(el);
      });
      const nodes = [];
      els.slice(0, maxNodes || 100).forEach((el, i) => {
        const ref = 'e' + (i + 1);
        el.setAttribute('data-ybaref', ref);
        const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title')
          || (el.value !== undefined ? String(el.value) : '') || (el.textContent || '').replace(/\\s+/g, ' ').trim()
          || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
        let css = el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase();
        if (!el.id && typeof el.className === 'string' && el.className.trim()) {
          el.className.trim().split(/\\s+/).slice(0, 2).forEach((c) => { if (c) css += '.' + CSS.escape(c); });
        }
        nodes.push({ ref, role: (el.getAttribute('role') || '') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName === 'INPUT' ? 'textbox' : el.tagName === 'TEXTAREA' ? 'textbox' : el.tagName === 'SELECT' ? 'combobox' : el.isContentEditable ? 'textbox' : ''), name, selector: css });
      });
      return { url: location.href, title: document.title, nodes, text: includeText ? (document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 6000) : '') : '' };
    },
    rect(sel) {
      const el = resolve(sel);
      if (!el) return { found: false };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }
      const r = el.getBoundingClientRect();
      return { found: true, x: r.left, y: r.top, w: r.width, h: r.height, inFrame: el.ownerDocument.defaultView !== window, ...tagInfo(el) };
    },
    prepareFill(sel) {
      const el = resolve(sel);
      if (!el) return { found: false };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }
      el.focus();
      if (el.tagName === 'SELECT') return { found: true, kind: 'select', inFrame: el.ownerDocument.defaultView !== window, ...tagInfo(el) };
      if (el.isContentEditable) { try { document.execCommand('selectAll'); } catch (_) { } return { found: true, kind: 'editable', inFrame: el.ownerDocument.defaultView !== window, ...tagInfo(el) }; }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { try { el.select(); } catch (_) { } return { found: true, kind: 'input', inFrame: el.ownerDocument.defaultView !== window, ...tagInfo(el) }; }
      return { found: true, kind: 'other', inFrame: el.ownerDocument.defaultView !== window, ...tagInfo(el) };
    },
    setSelect(sel, value) {
      const el = resolve(sel);
      if (!el || el.tagName !== 'SELECT') return { found: false };
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { found: true, value: el.value };
    }
  };
  window.__ybaDriver = driver;
  return true;
})()`;

/* --------------------------------- state ---------------------------------- */

async function getRelayUrl() {
  const s = await chrome.storage.local.get(STORE_KEY);
  return s[STORE_KEY] || DEFAULT_RELAY_URL;
}

async function setRelayUrl(url) {
  await chrome.storage.local.set({ [STORE_KEY]: url });
}

function broadcastState() {
  try { chrome.runtime.sendMessage({ type: "ybaState", connected, url: ws ? ws.url : null }); } catch (_) { }
}

/* ------------------------------ websocket core ----------------------------- */

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  getRelayUrl().then((url) => {
    let socket;
    try { socket = new WebSocket(url); } catch (e) { console.warn("[yba] bad relay URL:", url); return; }
    ws = socket;
    socket.onopen = () => {
      connected = true; broadcastState();
      socket.send(JSON.stringify({ type: "hello", name: "your-browser-agent", version: "0.2.0" }));
    };
    socket.onmessage = (ev) => { try { handleRelayMessage(JSON.parse(ev.data)); } catch (_) { } };
    socket.onclose = () => { if (ws === socket) { ws = null; connected = false; broadcastState(); scheduleReconnect(); } };
    socket.onerror = () => { try { socket.close(); } catch (_) { } };
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!ws || ws.readyState > WebSocket.OPEN) connect(); }, 800);
}

/* ------------------------------- serial queue ------------------------------ */

let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => { });
  return run;
}

/* --------------------------- relay message handling ------------------------ */

function handleRelayMessage(msg) {
  if (!msg || msg.type !== "cmd") return;
  enqueue(async () => {
    const id = msg.id;
    let resp;
    try {
      lastActivity = Date.now();
      const result = await dispatch(msg.cmd, msg.params || {});
      resp = { type: "resp", id, ok: true, result };
    } catch (e) {
      resp = { type: "resp", id, ok: false, error: (e && e.message) || String(e) };
    }
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(resp)); } catch (_) { }
  });
}

/* ------------------------------- tab helpers ------------------------------- */

async function resolveTab(tabId) {
  if (tabId) { await chrome.tabs.get(tabId).catch(() => { }); return tabId; }
  if (lastTabId) { try { const t = await chrome.tabs.get(lastTabId); if (t && t.id) return t.id; } catch (_) { } }
  const act = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (act[0] && act[0].id) return act[0].id;
  const all = await chrome.tabs.query({});
  const page = all.find((t) => t.url && t.url.startsWith("http"));
  if (page && page.id) return page.id;
  throw new Error("no usable tab — open a webpage first, or pass an explicit tabId");
}

async function ensureDebug(tabId) {
  if (dbg && dbg.tabId === tabId) return;
  if (dbg) { await chrome.debugger.detach({ tabId: dbg.tabId }).catch(() => { }); dbg = null; }
  await chrome.debugger.attach({ tabId }, "1.3");
  dbg = { tabId, attachedAt: Date.now() };
}

async function detachDebug() {
  if (dbg) { await chrome.debugger.detach({ tabId: dbg.tabId }).catch(() => { }); dbg = null; }
}

/* ---------------------------- CDP convenience ------------------------------ */

function cdp(method, params) {
  if (!dbg) return Promise.reject(new Error("no debugger session"));
  return chrome.debugger.sendCommand({ tabId: dbg.tabId }, method, params || {});
}

async function evalInPage(expression) {
  const res = await cdp("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails.exception;
    throw new Error((d && (d.description || d.value)) || res.exceptionDetails.text || "evaluate failed");
  }
  const v = res.result;
  if (v && v.type === "object" && !("value" in v) && v.subtype !== "null") {
    throw new Error("expression returned a non-serializable object (e.g. a DOM node) — return a plain value");
  }
  return "value" in v ? v.value : undefined;
}

async function ensureHelper() {
  const ok = await evalInPage(INSTALL_SRC);
  if (ok !== true) throw new Error("failed to install page helper");
}

/* -------------------------------- commands -------------------------------- */

async function waitForLoad(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  for (;;) {
    let rs = null;
    try { rs = await evalInPage("document.readyState"); } catch (_) { }
    if (rs === "complete") return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the page to finish loading");
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function dispatch(cmd, params) {
  switch (cmd) {
    case "ping":
      return { pong: true, ts: Date.now(), engine: "cdp-v2" };

    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("edge://"))
        .map((t) => ({ tabId: t.id, title: t.title || "", url: t.url || "", active: !!t.active, windowId: t.windowId }));
    }

    case "newTab": {
      const t = await chrome.tabs.create({ url: params.url || "about:blank" });
      lastTabId = t.id;
      if (params.url && params.waitUntil !== "none") {
        await ensureDebug(t.id).catch(() => { });
        await waitForLoad(t.id, params.timeoutMs).catch(() => { });
      }
      const info = await chrome.tabs.get(t.id);
      return { tabId: t.id, url: info.url || "", title: info.title || "" };
    }

    case "goto": {
      const tabId = await resolveTab(params.tabId);
      lastTabId = tabId;
      await chrome.tabs.update(tabId, { url: params.url });
      await ensureDebug(tabId).catch(() => { });
      if (params.waitUntil !== "none") await waitForLoad(tabId, params.timeoutMs).catch(() => { });
      const t = await chrome.tabs.get(tabId);
      return { tabId, url: t.url || "", title: t.title || "" };
    }

    case "activate": {
      const tabId = params.tabId || lastTabId;
      if (!tabId) throw new Error("no tab to activate — pass a tabId");
      await chrome.tabs.update(tabId, { active: true });
      lastTabId = tabId;
      return { tabId };
    }

    case "closeTab": {
      const tabId = params.tabId || lastTabId;
      if (tabId) { await chrome.tabs.remove(tabId).catch(() => { }); }
      if (dbg && dbg.tabId === tabId) dbg = null;
      return { closed: !!tabId };
    }

    case "snapshot": {
      const tabId = await resolveTab(params.tabId);
      lastTabId = tabId;
      await ensureDebug(tabId);
      await ensureHelper();
      return evalInPage("__ybaDriver.snapshot(" + (Number(params.maxNodes) || 100) + "," + (params.includeText !== false) + ")");
    }

    case "click": {
      const tabId = await resolveTab(params.tabId);
      lastTabId = tabId;
      await ensureDebug(tabId);
      await ensureHelper();
      const r = await evalInPage("__ybaDriver.rect(" + JSON.stringify(String(params.selector)) + ")");
      if (!r || !r.found) throw new Error("selector matched nothing: " + params.selector);
      if (r.inFrame) throw new Error("element is inside an iframe — drive it with evaluate() for now");
      const x = r.x + r.w / 2, y = r.y + r.h / 2;
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      return { clicked: true, tag: r.tag, role: r.role };
    }

    case "fill": {
      const tabId = await resolveTab(params.tabId);
      lastTabId = tabId;
      await ensureDebug(tabId);
      await ensureHelper();
      const value = params.value == null ? "" : String(params.value);
      const sel = String(params.selector);
      const p = await evalInPage("__ybaDriver.prepareFill(" + JSON.stringify(sel) + ")");
      if (!p || !p.found) throw new Error("selector matched nothing: " + sel);
      if (p.inFrame) throw new Error("element is inside an iframe — drive it with evaluate() for now");
      if (p.kind === "select") {
        const r = await evalInPage("__ybaDriver.setSelect(" + JSON.stringify(sel) + "," + JSON.stringify(value) + ")");
        return { filled: r && r.found, method: "select", tag: p.tag };
      }
      if (p.kind === "input" || p.kind === "editable") {
        await cdp("Input.insertText", { text: value });
        return { filled: true, method: "cdp-insertText", tag: p.tag };
      }
      throw new Error("element is not fillable (tag " + p.tag + ") — click it first if it is a custom widget");
    }

    case "press": {
      const tabId = await resolveTab(params.tabId);
      lastTabId = tabId;
      await ensureDebug(tabId);
      await ensureHelper();
      if (params.selector) {
        const p = await evalInPage("__ybaDriver.prepareFill(" + JSON.stringify(String(params.selector)) + ")");
        if (!p || !p.found) throw new Error("selector matched nothing: " + params.selector);
        if (p.inFrame) throw new Error("element is inside an iframe");
      }
      const key = String(params.key || "Enter");
      const spec = keySpec(key);
      await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...spec });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...spec });
      // printable characters also emit a char event; special keys don't
      if (spec.named === false && spec.text) {
        await cdp("Input.dispatchKeyEvent", { type: "char", text: spec.text, unmodifiedText: spec.text, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode });
      }
      return { pressed: key };
    }

    case "evaluate": {
      const tabId = await resolveTab(params.tabId);
      lastTabId = tabId;
      await ensureDebug(tabId);
      return evalInPage(String(params.expression || ""));
    }

    case "screenshot": {
      const tabId = await resolveTab(params.tabId);
      lastTabId = tabId;
      await ensureDebug(tabId);
      const fmt = params.format === "jpeg" ? "jpeg" : params.format === "webp" ? "webp" : "png";
      const res = await cdp("Page.captureScreenshot", {
        format: fmt,
        ...(fmt === "jpeg" && params.quality ? { quality: Number(params.quality) } : {}),
        ...(params.fullPage ? { captureBeyondViewport: true } : {}),
      });
      return { data: res.data, format: fmt, tabId };
    }

    default:
      throw new Error("unknown command: " + cmd);
  }
}

function keySpec(key) {
  const named = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  };
  if (named[key]) return { ...named[key], named: true };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = key >= "a" && key <= "z" ? "Key" + upper : key >= "0" && key <= "9" ? "Digit" + key : key === " " ? "Space" : "";
    return { key, code, windowsVirtualKeyCode: key === " " ? 32 : upper.charCodeAt(0), text: key, named: false };
  }
  return { key, code: "", windowsVirtualKeyCode: 0, named: true };
}

/* ------------------------------- lifecycle -------------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(() => { connect(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  if (!ws || ws.readyState > WebSocket.OPEN) connect();
  // detach the debugger after 2 minutes idle so the "started debugging" bar disappears
  if (dbg && Date.now() - lastActivity > 120000) detachDebug();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "ybaConnect") { connect(); sendResponse({ ok: true }); }
  else if (msg.type === "ybaSetUrl") {
    setRelayUrl(String(msg.url || DEFAULT_RELAY_URL)).then(() => {
      if (ws) { try { ws.close(); } catch (_) { } ws = null; }
      connected = false;
      connect();
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "ybaGetState") {
    getRelayUrl().then((u) => sendResponse({ connected, url: ws ? ws.url : null, configuredUrl: u, lastTabId }));
    return true;
  }
  return undefined;
});

chrome.tabs.onActivated.addListener((info) => { lastTabId = info.tabId; });
chrome.tabs.onCreated.addListener((tab) => { if (tab.id) lastTabId = tab.id; });
chrome.debugger.onDetach.addListener((source) => {
  if (dbg && source.tabId === dbg.tabId) dbg = null;
});

connect();
