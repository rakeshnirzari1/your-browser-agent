/* Your Browser Agent v3 — MV3 service worker.
 *
 * Drives the user's real Chrome over the Chrome DevTools Protocol (debugger
 * API): one persistent session per driven tab, a page helper installed per
 * frame into the MAIN world, and trusted CDP input events (isTrusted=true).
 *
 * Agent-facing command surface (reachable through the local relay):
 *   ping, tabs, newTab, goto, activate, closeTab, reload, back, forward,
 *   snapshot, frames, click, hover, fill, selectOptions, press, type,
 *   evaluate, waitFor, scroll, upload, screenshot, pdf, dialog
 *
 * Almost every action accepts an optional `frame` parameter (a frame index
 * from the `frames` command, a frameId, or a URL substring) so agents can
 * drive content inside iframes — including cross-origin ones (captchas,
 * embeds, payment widgets).
 */

"use strict";

const DEFAULT_RELAY_URL = "ws://127.0.0.1:7799/ext";
const STORE_KEY = "ybaRelayUrl";
const HEARTBEAT_ALARM = "yba-heartbeat";
const HELPER_VERSION = 4;
const EXT_VERSION = "1.0.0";

let ws = null;
let connected = false;
let lastTabId = null;
let reconnectTimer = null;
// true once the user presses Disconnect; suppresses auto-reconnect until they press Connect again
let manualDisconnect = false;

// One debugger session per driven tab, so multiple agents can concurrently
// drive different tabs without one attach kicking another tab's session off.
// tabId -> { tabId, frameCtx, navFrames, ctxGen, frameListCache, dialog, lastActivity }
const sessions = new Map();

function newSession(tabId) {
  return {
    tabId,
    // frameId -> default execution-context id (kept fresh from CDP events)
    frameCtx: new Map(),
    // frameId -> {url,name} best-effort, from Page.frameNavigated/Attached events
    navFrames: new Map(),
    // bumped whenever the context map is wiped; listFrames() caches against it
    ctxGen: 0,
    frameListCache: { gen: -1, list: null },
    // non-null while a JavaScript dialog (alert/confirm/prompt/beforeunload) is open on this tab
    dialog: null,
    lastActivity: Date.now(),
  };
}

/* ------------------------------ page helper --------------------------------
 * Installed once per frame load into that frame's MAIN world via
 * Runtime.evaluate. Self-contained: no closure over extension scope. */
const INSTALL_SRC = `(() => {
  if (window.__ybaDriver && window.__ybaDriver.v === ${HELPER_VERSION}) return true;
  const CLICKABLES = 'a[href], button, input, select, textarea, [role], summary, [contenteditable="true"], h1, h2, h3, h4, h5, label';
  const HIDDEN = 'input[type="hidden"]';
  function roleOf(el) {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'file') return 'file';
      if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return '';
  }
  function nameOf(el) {
    let n = '';
    const grab = (v) => { if (!n && v != null) n = String(v); };
    grab(el.getAttribute && el.getAttribute('aria-label'));
    grab(el.getAttribute && el.getAttribute('placeholder'));
    grab(el.getAttribute && el.getAttribute('title'));
    if (el.tagName === 'INPUT') grab(el.value);
    if (el.tagName === 'SELECT') { const o = el.options && el.options[el.selectedIndex]; grab(o ? o.text : ''); }
    if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || (el.getAttribute && el.getAttribute('role') === 'button')) grab((el.textContent || '').replace(/\\s+/g, ' ').trim());
    grab(el.getAttribute && el.getAttribute('alt'));
    if (!n && el.textContent) n = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return n.replace(/\\s+/g, ' ').trim().slice(0, 200);
  }
  function visible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return !(r.width === 0 && r.height === 0);
  }
  function resolve(sel) {
    const s = String(sel).trim();
    if (!s) return null;
    let m = s.match(/^@?(e\\d+)$/);
    if (m) return document.querySelector('[data-ybaref="' + m[1] + '"]');
    m = s.match(/^text=(?:'([^']*)'|"([^"]*)")\\s*$/);
    if (m) { const w = m[1] != null ? m[1] : m[2]; for (const el of document.querySelectorAll(CLICKABLES)) { if (el.matches(HIDDEN)) continue; if ((el.textContent || '').trim() === w) return el; } return null; }
    m = s.match(/^text=(.+)$/);
    if (m) { const w = m[1].trim(); for (const el of document.querySelectorAll(CLICKABLES)) { if (el.matches(HIDDEN)) continue; if ((el.textContent || '').includes(w)) return el; } return null; }
    m = s.match(/^role=([\\w-]+)(?:\\[name=(?:'([^']*)'|"([^"]*)")\\])?\\s*$/);
    if (m) {
      const wr = m[1], wn = m[2] != null ? m[2] : m[3];
      for (const el of document.querySelectorAll('[role], a[href], button, input, select, textarea, [contenteditable="true"]')) {
        if (roleOf(el) !== wr) continue;
        if (wn == null) return el;
        const name = nameOf(el);
        if (name === wn) return el;
      }
      return null;
    }
    const css = s.startsWith('css=') ? s.slice(4) : s;
    try { return document.querySelector(css); } catch (_) { return null; }
  }
  function tagInfo(el) {
    return { ref: el.getAttribute('data-ybaref'), role: roleOf(el), tag: el.tagName };
  }
  function nativeValueSetter(el) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, 'value').set;
  }
  const driver = {
    v: ${HELPER_VERSION},
    resolve(sel) { return resolve(sel); },
    rawFind(sel) { return resolve(sel) || null; },
    visible(sel) { const el = resolve(sel); return !!el && visible(el); },
    exists(sel) { return !!resolve(sel); },
    snapshot(maxNodes, includeText) {
      const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [role="option"], [role="searchbox"], [role="listbox"], [role="spinbutton"], [role="slider"], [role="switch"], [role="heading"], [role="dialog"], [role="menu"], [role="gridcell"], [contenteditable="true"], summary';
      const els = [];
      document.querySelectorAll(sel).forEach((el) => {
        if (!visible(el)) return;
        if (el.closest && el.closest('[aria-hidden="true"]')) return;
        els.push(el);
      });
      const nodes = [];
      els.slice(0, maxNodes || 100).forEach((el, i) => {
        const ref = 'e' + (i + 1);
        el.setAttribute('data-ybaref', ref);
        let css = el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase();
        if (!el.id && typeof el.className === 'string' && el.className.trim()) {
          el.className.trim().split(/\\s+/).slice(0, 2).forEach((c) => { if (c) css += '.' + CSS.escape(c); });
        }
        nodes.push({ ref, role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), selector: css });
      });
      return { url: location.href, title: document.title, nodes, text: includeText ? (document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 6000) : '') : '' };
    },
    rect(sel) {
      const el = resolve(sel);
      if (!el) return { found: false };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }
      const r = el.getBoundingClientRect();
      return { found: true, x: r.left, y: r.top, w: r.width, h: r.height, ...tagInfo(el) };
    },
    trustedPoint(sel) {
      const el = resolve(sel);
      if (!el) return { ok: false, reason: 'selector matched nothing: ' + sel };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return { ok: false, reason: 'element has no visible box (tag ' + el.tagName + ')' };
      const fracs = [0.5, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9, 0.0, 1.0];
      const good = (x, y) => {
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      };
      for (const fy of fracs) for (const fx of fracs) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (x <= 0 || y <= 0) continue;
        if (good(x, y)) return { ok: true, x, y, w: r.width, h: r.height };
      }
      let blocker = '';
      try {
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (t && t !== el) blocker = ' by ' + t.tagName.toLowerCase() + (t.getAttribute && t.getAttribute('aria-label') ? '[' + t.getAttribute('aria-label') + ']' : '') + (t.textContent ? ' "' + t.textContent.trim().slice(0, 50) + '"' : '');
      } catch (_) { }
      return { ok: false, reason: 'element is covered' + blocker + ' — try method:"js" (synthetic click) or a different selector' };
    },
    frameBox() {
      try {
        const fe = window.frameElement;
        if (!fe) return { ok: false, reason: 'top-level frame' };
        const b = fe.getBoundingClientRect();
        return { ok: true, x: b.left, y: b.top, w: b.width, h: b.height };
      } catch (e) {
        return { ok: false, reason: 'cross-origin frame geometry blocked: ' + (e && e.message ? e.message : e) };
      }
    },
    scrollFrameIntoView() {
      try {
        const fe = window.frameElement;
        if (!fe) return false;
        fe.scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      } catch (_) { return false; }
    },
    prepareFill(sel) {
      const el = resolve(sel);
      if (!el) return { found: false };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }
      try { el.focus(); } catch (_) { }
      const role = roleOf(el);
      if (el.tagName === 'SELECT') return { found: true, kind: 'select', ...tagInfo(el) };
      if (role === 'checkbox' || role === 'radio') return { found: true, kind: 'check', checked: !!el.checked, ...tagInfo(el) };
      if (role === 'file') return { found: true, kind: 'file', ...tagInfo(el) };
      if (el.isContentEditable) { try { document.execCommand('selectAll'); } catch (_) { } return { found: true, kind: 'editable', ...tagInfo(el) }; }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { try { el.select(); } catch (_) { } return { found: true, kind: 'input', ...tagInfo(el) }; }
      return { found: true, kind: 'other', ...tagInfo(el) };
    },
    setChecked(sel, on) {
      const el = resolve(sel);
      if (!el) return { found: false };
      const want = on === true || on === 'true' || on === 'checked' || on === 1 || on === '1';
      if (!!el.checked !== want) {
        el.checked = want;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { found: true, checked: !!el.checked };
    },
    setSelect(sel, value) {
      const el = resolve(sel);
      if (!el || el.tagName !== 'SELECT') return { found: false };
      const v = String(value);
      let opt = null;
      for (const o of el.options) { if (o.value === v) { opt = o; break; } }
      if (!opt) for (const o of el.options) { if ((o.text || '').trim() === v) { opt = o; break; } }
      if (!opt) for (const o of el.options) { if ((o.text || '').includes(v) || (o.value || '').includes(v)) { opt = o; break; } }
      if (!opt) return { found: true, matched: false };
      if (el.multiple) { opt.selected = !opt.selected; } else { el.value = opt.value; }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { found: true, matched: true, label: (opt.text || '').trim(), value: opt.value };
    },
    selectOptions(sel) {
      const el = resolve(sel);
      if (!el || el.tagName !== 'SELECT') return { found: false };
      return {
        found: true,
        multiple: !!el.multiple,
        selected: el.selectedIndex,
        options: Array.from(el.options).map((o, i) => ({ index: i, value: o.value, label: (o.text || '').trim(), selected: o.selected }))
      };
    },
    fillValue(sel, value) {
      const el = resolve(sel);
      if (!el) return { found: false, reason: 'selector matched nothing' };
      const v = String(value);
      const role = roleOf(el);
      try { el.focus(); } catch (_) { }
      if (el.tagName === 'SELECT') return this.setSelect(sel, value);
      if (role === 'checkbox' || role === 'radio') return this.setChecked(sel, value);
      if (el.isContentEditable) {
        try { document.execCommand('selectAll'); document.execCommand('insertText', false, v); return { found: true, method: 'execCommand' }; } catch (e) { return { found: false, reason: String(e && e.message || e) }; }
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const setter = nativeValueSetter(el);
        try {
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, method: 'native-setter' };
        } catch (e) { return { found: false, reason: String(e && e.message || e) }; }
      }
      return { found: false, reason: 'element is not fillable (tag ' + el.tagName + ')' };
    },
    jsClick(sel) {
      const el = resolve(sel);
      if (!el) return { found: false };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }
      el.focus();
      el.click();
      return { found: true, ...tagInfo(el) };
    },
    iframes() {
      // direct iframe elements of THIS document (main frame usage), with
      // the same-origin URL when readable; cross-origin children yield null
      const out = [];
      document.querySelectorAll('iframe, frame').forEach((el, i) => {
        let url = null;
        try { const w = el.contentWindow; if (w) { try { url = w.location.href; } catch (_) { url = null; } } } catch (_) { }
        out.push({ index: i, src: el.getAttribute('src') || el.src || '', name: el.getAttribute('name') || '', id: el.id || '', url });
      });
      return out;
    },
    frameBox(sel) {
      const el = resolve(sel);
      if (!el) return { found: false };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }
      const r = el.getBoundingClientRect();
      return { found: true, x: r.left, y: r.top, w: r.width, h: r.height, tag: el.tagName };
    },
    frameOffset(target) {
      // Recursively locate the frame whose document URL equals the target
      // (walking same-origin content documents from this one) and return the
      // box of that frame in THIS document's viewport coordinates, scrolling
      // each level into view. Works for same-origin chains only.
      const want = String(target).split('#')[0];
      const retBox = (el) => { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { } const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, hit: true, bySrc: false }; };
      const search = (doc) => {
        for (const el of doc.querySelectorAll('iframe, frame')) {
          let u = null;
          try { const w = el.contentWindow; if (w) { try { u = w.location.href; } catch (_) { u = null; } } } catch (_) { }
          let src = null;
          try { src = (el.getAttribute('src') || '').split('#')[0]; } catch (_) { }
          if (u && u.split('#')[0] === want) return retBox(el);
          if (!u && src === want) return { ...retBox(el), bySrc: true };
          let cd = null;
          try { cd = el.contentDocument; } catch (_) { cd = null; }
          if (cd && cd !== doc) {
            const r = search(cd);
            if (r) {
              const b = retBox(el);
              return { x: b.x + r.x, y: b.y + r.y, w: r.w || b.w, h: r.h || b.h, hit: true, bySrc: r.bySrc };
            }
          }
        }
        return null;
      };
      return search(document) || { hit: false };
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
  // no popup may be open to receive this — swallow the expected rejection
  try {
    chrome.runtime.sendMessage({ type: "ybaState", connected, url: ws ? ws.url : null, manualDisconnect }).catch(() => { });
  } catch (_) { }
}

/* ------------------------------ websocket core ----------------------------- */

function connect() {
  manualDisconnect = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  getRelayUrl().then((url) => {
    let socket;
    try { socket = new WebSocket(url); } catch (e) { console.warn("[yba] bad relay URL:", url); return; }
    ws = socket;
    socket.onopen = () => {
      connected = true; broadcastState();
      socket.send(JSON.stringify({ type: "hello", name: "your-browser-agent", version: EXT_VERSION }));
    };
    socket.onmessage = (ev) => { try { handleRelayMessage(JSON.parse(ev.data)); } catch (_) { } };
    socket.onclose = () => { if (ws === socket) { ws = null; connected = false; broadcastState(); if (!manualDisconnect) scheduleReconnect(); } };
    socket.onerror = () => { try { socket.close(); } catch (_) { } };
  });
}

function disconnect() {
  manualDisconnect = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) { } ws = null; }
  connected = false;
  broadcastState();
}

function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!manualDisconnect && (!ws || ws.readyState > WebSocket.OPEN)) connect(); }, 800);
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
      // best-effort per-tab dialog guard: only checks a tab we can resolve
      // without the async tab-query machinery dispatch() itself uses.
      const checkTabId = (msg.params && msg.params.tabId) || lastTabId;
      const checkSession = checkTabId ? sessions.get(checkTabId) : null;
      if (checkSession && checkSession.dialog && msg.cmd !== "dialog" && msg.cmd !== "ping" && msg.cmd !== "tabs") {
        throw new Error('a JavaScript dialog is open (' + (checkSession.dialog.type || "unknown") + (checkSession.dialog.message ? ': "' + checkSession.dialog.message.slice(0, 120) + '"' : "") + ') — resolve it first with {"cmd":"dialog","params":{"accept":true|false}}');
      }
      // absolute cap so one stuck call can never freeze the queue; the relay
      // normally times out first (its cap is min(params.timeoutMs, 120s))
      const result = await Promise.race([
        dispatch(msg.cmd, msg.params || {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error("command timed out inside the extension (is the page stuck, or is a dialog open?)")), 115000)),
      ]);
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

async function resolveTargetTab(params) {
  const tabId = await resolveTab(params && params.tabId);
  lastTabId = tabId;
  return tabId;
}

/* ------------------------------ debugger core ------------------------------ */

async function ensureDebug(tabId) {
  let s = sessions.get(tabId);
  if (s) { s.lastActivity = Date.now(); return s; }
  await chrome.debugger.attach({ tabId }, "1.3");
  s = newSession(tabId);
  sessions.set(tabId, s);
  // enable the domains we drive through; Runtime.enable makes Chrome report
  // every frame's execution context so we can target iframes individually.
  await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => { });
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => { });
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable").catch(() => { });
  return s;
}

async function detachDebug(tabId) {
  if (!sessions.has(tabId)) return;
  sessions.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => { });
}

function cdp(tabId, method, params) {
  if (!sessions.has(tabId)) return Promise.reject(new Error("no debugger session for tab " + tabId));
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

/* ---------------------------- CDP event intake ----------------------------- */

chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(source.tabId);
  if (!s) return;
  if (method === "Runtime.executionContextCreated") {
    const c = params && params.context;
    if (c && c.auxData && c.auxData.isDefault && c.auxData.frameId) s.frameCtx.set(c.auxData.frameId, c.id);
  } else if (method === "Runtime.executionContextsCleared") {
    s.frameCtx.clear(); s.ctxGen++;
  } else if (method === "Runtime.executionContextDestroyed") {
    const id = params && params.executionContextId;
    for (const [fid, cid] of s.frameCtx) { if (cid === id) { s.frameCtx.delete(fid); break; } }
  } else if (method === "Page.frameNavigated") {
    const f = params && params.frame;
    if (f && f.id) s.navFrames.set(f.id, { url: f.url || "", name: f.name || "" });
  } else if (method === "Page.frameAttached") {
    const p = params || {};
    if (p.frameId) s.navFrames.set(p.frameId, { url: (s.navFrames.get(p.frameId) || {}).url || "", name: p.name || "" });
  } else if (method === "Page.javascriptDialogOpening") {
    s.dialog = { type: params.type || "alert", message: params.message || "", defaultPrompt: params.defaultPrompt || "" };
    // beforeunload dialogs would otherwise silently hang navigations — clear them.
    if (s.dialog.type === "beforeunload") {
      setTimeout(() => {
        if (s.dialog && s.dialog.type === "beforeunload") {
          cdp(s.tabId, "Page.handleJavaScriptDialog", { accept: true }).then(() => { s.dialog = null; }).catch(() => { });
        }
      }, 300);
    }
  } else if (method === "Page.javascriptDialogClosed") {
    s.dialog = null;
  }
});

/* ---------------------------- CDP convenience ------------------------------ */

async function evalInPage(tabId, expression) {
  const res = await cdp(tabId, "Runtime.evaluate", {
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

async function evalInContext(tabId, contextId, expression) {
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression, contextId, returnByValue: true, awaitPromise: true, userGesture: true,
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

async function ensureHelper(tabId, contextId) {
  const ok = contextId == null ? await evalInPage(tabId, INSTALL_SRC) : await evalInContext(tabId, contextId, INSTALL_SRC);
  if (ok !== true) throw new Error("failed to install page helper");
}

/* ------------------------------- frame helpers ----------------------------- */
/* NOTE ON IFRAMES
 * A chrome.debugger page session can run JS only in frames that share the
 * page's renderer process (same-origin, about:srcdoc, blob:). Out-of-process
 * cross-origin frames (OOPIFs: most third-party embeds and captchas) cannot
 * be read or scripted through this API — reaching them needs browser-level
 * child sessions, which the extension debugger API does not expose. They are
 * still listed, and trusted pointer events CAN be sent into them by
 * coordinates (the browser hit-tests and routes input into the right
 * process), so agents can click captcha checkboxes etc. by screenshot. */

async function getFrameTree(tabId) {
  const res = await cdp(tabId, "Page.getFrameTree");
  return res.frameTree || { frame: null };
}

async function getCtxId(tabId, frameId, timeoutMs) {
  const s = sessions.get(tabId);
  const deadline = Date.now() + (timeoutMs || 2500);
  while (Date.now() < deadline) {
    const c = s && s.frameCtx.get(frameId);
    if (c) return c;
    await new Promise((r) => setTimeout(r, 60));
  }
  return (s && s.frameCtx.get(frameId)) || null;
}

function frameSelectorFromEl(el) {
  if (!el) return null;
  const esc = (v) => v.replace(/[\\"]/g, (m) => "\\" + m);
  if (el.id) return '[id="' + esc(el.id) + '"]';
  if (el.src) return 'iframe[src="' + esc(el.src) + '"]';
  if (el.name) return 'iframe[name="' + esc(el.name) + '"]';
  return null;
}

/** Current frame listing: main first, then sub-frames in DOM order.
 * Entries: { index, frameId, url, crossOrigin, reachable, selector }.
 * `reachable` = we can run JS inside (same-origin); cross-origin frames are
 * listed for coordinate clicks but cannot be read or scripted. */
async function listFrames(tabId) {
  const s = sessions.get(tabId);
  if (s && s.frameListCache.gen === s.ctxGen && s.frameListCache.list) {
    return s.frameListCache.list;
  }
  const tree = await getFrameTree(tabId);
  const mainFid = (tree && tree.frame && tree.frame.id) || null;
  const mainUrl = (tree && tree.frame && tree.frame.url) || "";
  const norm = (u) => { try { return new URL(u).href.split("#")[0]; } catch (_) { return String(u); } };

  // probe every known execution context (same-origin frames report their URL)
  const children = [];
  for (const [fid, cid] of s.frameCtx) {
    if (mainFid && fid === mainFid) continue;
    let url = null, ok = false;
    try {
      const v = await withTimeout(evalInContext(tabId, cid, "location.href"), 900);
      if (typeof v === "string" && v) { url = v; ok = true; }
    } catch (_) { }
    if (!ok) url = (s.navFrames.get(fid) || {}).url || null;
    children.push({ frameId: fid, url, ok });
  }
  // iframe elements as seen from the main document (same + cross origin)
  let domEls = [];
  try { await ensureHelper(tabId, null); domEls = (await evalInPage(tabId, "__ybaDriver.iframes()")) || []; } catch (_) { }

  const list = [{ index: 0, frameId: mainFid, url: mainUrl, crossOrigin: false, reachable: true, selector: null }];
  const used = new Set([mainFid]);
  const pushChild = (c, el) => {
    if (used.has(c.frameId)) return;
    used.add(c.frameId);
    list.push({
      index: list.length,
      frameId: c.frameId,
      url: c.url,
      crossOrigin: !c.ok,
      reachable: c.ok,
      selector: frameSelectorFromEl(el),
    });
  };
  // DOM order first: pair each element with its matching child context
  for (const el of domEls) {
    if (!el.url && !el.src) continue;
    const key = norm(el.url || el.src);
    const hit = children.find((c) => c.ok && c.url && norm(c.url) === key);
    if (hit) pushChild(hit, el);
    else if (!el.url && el.src) {
      // cross-origin child: no usable context, but the element is real
      const navHit = children.find((c) => !c.ok && c.url && norm(c.url) === key);
      pushChild(navHit || { frameId: null, url: el.src, ok: false }, el);
    }
  }
  // leftovers: dynamic frames with no matching element (or late contexts)
  for (const c of children) pushChild(c, null);

  const out = { frames: list };
  if (s) s.frameListCache = { gen: s.ctxGen, list: out };
  return out;
}

/** Resolve the `frame` action param. Accepts:
 *  - omitted / "main" / 0          -> the main (top-level) frame
 *  - a number                      -> index into the `frames` listing
 *  - a frameId / URL substring     -> matching frame
 *  - a CSS/selector for an iframe element in the main document (e.g. "#f1")
 *    -> element-based target (the only way to reach cross-origin frames) */
async function resolveFrameTarget(tabId, params) {
  const p = params.frame;
  const { frames } = await listFrames(tabId);
  const noMatch = () => { throw new Error("frame '" + p + "' matched no frame — run the frames command to list available frames"); };
  if (p == null || p === "" || p === "main" || p === 0 || p === "0") {
    const f = frames[0];
    return { frameId: f.frameId, ctxId: null, isMain: true, index: 0, crossOrigin: false, url: f.url || null, selector: null };
  }
  let f, index;
  if (typeof p === "number") {
    f = frames[p]; index = p;
    if (!f) noMatch();
  } else {
    const s = String(p);
    f = frames.find((x) => x.frameId === s);
    if (f) index = frames.indexOf(f);
    else {
      const hits = frames.filter((x) => x.url && x.url.includes(s));
      if (hits.length === 1) { f = hits[0]; index = frames.indexOf(f); }
    }
  }
  if (!f) {
    // element-based target: an iframe identified from the main document
    let probe = null;
    try {
      await ensureHelper(tabId, null);
      probe = await evalInPage(tabId, `(() => { const el = __ybaDriver.rawFind(${JSON.stringify(String(p))}); if (!el) return null; const t = el.tagName.toLowerCase(); if (t !== 'iframe' && t !== 'frame') return { notFrame: true }; let url = null; try { const w = el.contentWindow; if (w) { try { url = w.location.href; } catch (_) { url = null; } } } catch (_) { } return { src: el.getAttribute('src') || '', url }; })()`);
    } catch (_) { }
    if (!probe) noMatch();
    if (probe.notFrame) throw new Error("frame selector '" + p + "' matched an element that is not an iframe");
    if (probe.url) {
      // same-origin (readable) — map back to its execution-context entry
      const key = (() => { try { return new URL(probe.url).href.split("#")[0]; } catch (_) { return probe.url; } })();
      const { frames: fl } = await listFrames(tabId);
      const match = fl.find((x) => x.url && (() => { try { return new URL(x.url).href.split("#")[0] === key; } catch (_) { return x.url === probe.url; } })());
      if (match) { f = match; index = fl.indexOf(f); }
      else { f = null; }
    }
    if (!f) {
      // genuinely cross-origin: element-only target
      return { frameId: null, ctxId: null, isMain: false, index: -1, crossOrigin: true, url: probe.src || null, selector: String(p), element: true };
    }
  }
  let ctxId = null;
  if (!f.crossOrigin && f.frameId) {
    const s = sessions.get(tabId);
    ctxId = (s && s.frameCtx.get(f.frameId)) || await getCtxId(tabId, f.frameId, 900);
  }
  return { frameId: f.frameId, ctxId, isMain: index === 0, index, crossOrigin: !!f.crossOrigin, url: f.url || null, selector: f.selector || null };
}

/** Top-level viewport point for a click/hover inside a frame.
 *  - main frame:        direct element point
 *  - same-origin frame: local element point + recursive iframe offset
 *  - cross-origin frame: caller must pass `point` ({x,y} px or {fx,fy} of the
 *    frame box); geometry comes from the frame element in the main document */
async function globalPointFor(tabId, params, target, localPoint) {
  if (target.isMain) {
    if (!localPoint || !localPoint.ok) throw new Error((localPoint && localPoint.reason) || "element not clickable: " + params.selector);
    return { x: Math.round(localPoint.x), y: Math.round(localPoint.y), method: "trusted" };
  }
  if (target.crossOrigin) {
    const sel = target.selector || String(params.frame);
    let box = null;
    try {
      box = await evalInPage(tabId, "__ybaDriver.frameBox(" + JSON.stringify(sel) + ")");
    } catch (_) { }
    if (!box || !box.found) throw new Error("cannot locate frame " + sel + " in the main document");
    let x, y;
    const pt = params.point || {};
    if (typeof pt.x === "number" && typeof pt.y === "number" && !(pt.fx != null || pt.fy != null)) { x = box.x + pt.x; y = box.y + pt.y; }
    else { const fx = pt.fx != null ? Number(pt.fx) : 0.5; const fy = pt.fy != null ? Number(pt.fy) : 0.5; x = box.x + box.w * fx; y = box.y + box.h * fy; }
    return { x: Math.round(x), y: Math.round(y), method: "trusted-coords", box };
  }
  // same-origin sub-frame: offset chain from the main document
  let off = null;
  if (target.url) {
    try { off = await evalInPage(tabId, "__ybaDriver.frameOffset(" + JSON.stringify(target.url) + ")"); } catch (_) { }
  }
  if ((!off || !off.hit) && target.selector) {
    try { const b = await evalInPage(tabId, "__ybaDriver.frameBox(" + JSON.stringify(target.selector) + ")"); if (b && b.found) off = { x: b.x, y: b.y, hit: true }; } catch (_) { }
  }
  if (!off || !off.hit) throw new Error("could not compute the frame's on-screen position — pass a main-document selector as `frame` or use method:\"js\"");
  if (!localPoint || !localPoint.ok) throw new Error((localPoint && localPoint.reason) || "element not clickable: " + params.selector);
  return { x: Math.round(off.x + localPoint.x), y: Math.round(off.y + localPoint.y), method: "trusted" };
}

/* --------------------------------- helpers -------------------------------- */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Resolve when the promise settles, or null after `ms` — lets input events
 *  survive a page that pauses mid-dispatch (e.g. alert() opening inside the
 *  click we are still delivering). */
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
}

async function waitForLoad(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  for (;;) {
    let rs = null;
    try { rs = await evalInPage(tabId, "document.readyState"); } catch (_) { }
    if (rs === "complete") return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the page to finish loading");
    await sleep(120);
  }
}

async function inputMouse(tabId, x, y, button, double) {
  const btn = button || "left";
  const downButtons = btn === "left" ? 1 : btn === "right" ? 2 : 4;
  const base = { x, y };
  await withTimeout(cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base }), 3000);
  const clicks = double ? 2 : 1;
  for (let i = 1; i <= clicks; i++) {
    await withTimeout(cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base, button: btn, buttons: downButtons, clickCount: i }), 3000);
    await withTimeout(cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base, button: btn, buttons: 0, clickCount: i }), 3000);
  }
  // let the page run its handlers (a JS dialog may open — its CDP event needs a tick)
  await sleep(120);
}

/* ---------------------------- US keyboard tables --------------------------- */

const US_VK = {
  "`": 192, "1": 49, "2": 50, "3": 51, "4": 52, "5": 53, "6": 54, "7": 55, "8": 56, "9": 57, "0": 48,
  "-": 189, "=": 187, q: 81, w: 87, e: 69, r: 82, t: 84, y: 89, u: 85, i: 73, o: 79, p: 80,
  "[": 219, "]": 221, "\\": 220, a: 65, s: 83, d: 68, f: 70, g: 71, h: 72, j: 74, k: 75, l: 76,
  ";": 186, "'": 222, z: 90, x: 88, c: 67, v: 86, b: 66, n: 78, m: 77, ",": 188, ".": 190, "/": 191, " ": 32,
};
const US_CODE = {
  "`": "Backquote", "1": "Digit1", "2": "Digit2", "3": "Digit3", "4": "Digit4", "5": "Digit5",
  "6": "Digit6", "7": "Digit7", "8": "Digit8", "9": "Digit9", "0": "Digit0", "-": "Minus", "=": "Equal",
  q: "KeyQ", w: "KeyW", e: "KeyE", r: "KeyR", t: "KeyT", y: "KeyY", u: "KeyU", i: "KeyI", o: "KeyO", p: "KeyP",
  "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", a: "KeyA", s: "KeyS", d: "KeyD", f: "KeyF",
  g: "KeyG", h: "KeyH", j: "KeyJ", k: "KeyK", l: "KeyL", ";": "Semicolon", "'": "Quote", z: "KeyZ", x: "KeyX",
  c: "KeyC", v: "KeyV", b: "KeyB", n: "KeyN", m: "KeyM", ",": "Comma", ".": "Period", "/": "Slash", " ": "Space",
};
const US_SHIFTED = { "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`" };

function modBits(mods) {
  const list = mods || [];
  let bits = 0;
  const add = (name, bit) => { if (list.includes(name) || list.includes(name.toLowerCase())) bits |= bit; };
  add("Alt", 1); add("Control", 2); add("Meta", 4); add("Shift", 8);
  add("alt", 1); add("ctrl", 2); add("meta", 4); add("shift", 8);
  // convenience spellings
  if (list.includes("Ctrl") || list.includes("ctrl")) bits |= 2;
  if (list.includes("Cmd") || list.includes("cmd") || list.includes("Win") || list.includes("win")) bits |= 4;
  return bits;
}

function modKeySpec(name) {
  const n = String(name).toLowerCase();
  if (n === "control" || n === "ctrl") return { key: "Control", code: "ControlLeft", vk: 17 };
  if (n === "shift") return { key: "Shift", code: "ShiftLeft", vk: 16 };
  if (n === "alt" || n === "option") return { key: "Alt", code: "AltLeft", vk: 18 };
  if (n === "meta" || n === "cmd" || n === "win") return { key: "Meta", code: "MetaLeft", vk: 91 };
  return null;
}

function namedKeySpec(key) {
  const named = {
    Enter: { key: "Enter", code: "Enter", vk: 13 },
    Return: { key: "Enter", code: "Enter", vk: 13 },
    Tab: { key: "Tab", code: "Tab", vk: 9 },
    Escape: { key: "Escape", code: "Escape", vk: 27 },
    Esc: { key: "Escape", code: "Escape", vk: 27 },
    Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
    Delete: { key: "Delete", code: "Delete", vk: 46 },
    Insert: { key: "Insert", code: "Insert", vk: 45 },
    Home: { key: "Home", code: "Home", vk: 36 },
    End: { key: "End", code: "End", vk: 35 },
    PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
    PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
    Control: { key: "Control", code: "ControlLeft", vk: 17 },
    Ctrl: { key: "Control", code: "ControlLeft", vk: 17 },
    Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
    Alt: { key: "Alt", code: "AltLeft", vk: 18 },
    Meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  };
  for (let i = 1; i <= 12; i++) named["F" + i] = { key: "F" + i, code: "F" + i, vk: 111 + i };
  const hit = named[key] || named[key[0].toUpperCase() + key.slice(1)];
  return hit ? { ...hit, named: true } : null;
}

function charKeySpec(ch) {
  if (ch.length !== 1) return null;
  const shiftedBase = US_SHIFTED[ch];
  if (shiftedBase) {
    return { base: shiftedBase, key: ch, shift: true, text: ch };
  }
  const low = ch.toLowerCase();
  if (US_VK[low] != null) {
    const isUpper = ch !== low;
    const base = low;
    return { base, key: isUpper ? ch : low, shift: isUpper, text: ch };
  }
  return null; // untypeable via US layout — caller falls back to Input.insertText
}

function keyEventsFor(key, mods) {
  // returns array of {type, key, code, windowsVirtualKeyCode, modifiers, text?}
  const events = [];
  const extra = Array.isArray(mods) ? mods.slice() : [];
  const downOrder = ["Control", "Alt", "Shift", "Meta"]; // keydown order; bits applied incrementally
  const modKeys = downOrder.filter((m) => (modBits([m]) & modBits(extra)) !== 0 || extra.some((x) => modKeySpec(x) && modKeySpec(x).key === m));
  let bits = 0;
  const push = (type, spec, text) => {
    events.push({ type, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers: bits, ...(text != null ? { text } : {}) });
  };
  for (const m of modKeys) {
    const spec = modKeySpec(m);
    bits |= modBits([m]);
    push("rawKeyDown", spec);
  }
  const named = namedKeySpec(key);
  let baseText = null;
  if (named) {
    push("rawKeyDown", named);
    if (named.key === "Enter") baseText = "\r";
    if (named.key === "Tab") baseText = "\t";
    push("keyUp", named);
  } else {
    const cs = charKeySpec(key);
    if (!cs) {
      // can't be expressed as a US key event — agent should use fill/insertText
      return { fallbackText: key };
    }
    const baseSpec = { key: cs.base, code: US_CODE[cs.base] || "", vk: US_VK[cs.base] || 0 };
    if (cs.shift) { bits |= 8; push("rawKeyDown", modKeySpec("Shift")); }
    push("rawKeyDown", baseSpec, cs.text);
    push("char", { key: cs.text, code: baseSpec.code, vk: baseSpec.vk }, cs.text);
    push("keyUp", baseSpec);
    if (cs.shift) { push("keyUp", modKeySpec("Shift")); }
  }
  for (let i = modKeys.length - 1; i >= 0; i--) {
    const spec = modKeySpec(modKeys[i]);
    bits &= ~modBits([modKeys[i]]);
    push("keyUp", spec);
  }
  return { events };
}

async function dispatchKeySequence(tabId, seq) {
  for (const ev of seq) {
    const params = { type: ev.type, key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.windowsVirtualKeyCode, modifiers: ev.modifiers };
    if (ev.type === "char") { params.text = ev.text; params.unmodifiedText = ev.text; }
    await withTimeout(cdp(tabId, "Input.dispatchKeyEvent", params), 3000);
  }
}

/* -------------------------------- commands -------------------------------- */

async function dispatch(cmd, params) {
  switch (cmd) {

    case "ping":
      return { pong: true, ts: Date.now(), engine: "cdp-v3", version: EXT_VERSION };

    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("edge://") && !t.url.startsWith("chrome-extension://"))
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
      const tabId = await resolveTargetTab(params);
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
      await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true }).catch(() => { });
      lastTabId = tabId;
      return { tabId };
    }

    case "closeTab": {
      const tabId = params.tabId || lastTabId;
      if (tabId) { await chrome.tabs.remove(tabId).catch(() => { }); }
      if (sessions.has(tabId)) { sessions.delete(tabId); }
      return { closed: !!tabId };
    }

    case "reload": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId).catch(() => { });
      await cdp(tabId, "Page.reload", { ignoreCache: !!params.ignoreCache }).catch(() => { });
      if (params.waitUntil !== "none") await waitForLoad(tabId, params.timeoutMs).catch(() => { });
      const t = await chrome.tabs.get(tabId);
      return { tabId, url: t.url || "", title: t.title || "" };
    }

    case "back":
    case "forward": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const hist = await cdp(tabId, "Page.getNavigationHistory");
      const dir = cmd === "back" ? -1 : 1;
      const target = hist.currentIndex + dir;
      if (target < 0 || target >= hist.entries.length) {
        return { navigated: false, reason: cmd === "back" ? "no previous page in history" : "no next page in history" };
      }
      await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: hist.entries[target].id });
      if (params.waitUntil !== "none") await waitForLoad(tabId, params.timeoutMs).catch(() => { });
      const t = await chrome.tabs.get(tabId);
      return { navigated: true, tabId, url: t.url || "", title: t.title || "" };
    }

    case "frames": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const { frames } = await listFrames(tabId);
      return { tabId, frames };
    }

    case "snapshot": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const target = await resolveFrameTarget(tabId, params);
      if (target.crossOrigin) throw new Error("cannot snapshot inside a cross-origin frame — Chrome's extension debugger API cannot read out-of-process frames. Same-origin iframes are fully supported; for cross-origin frames take a page screenshot instead.");
      if (!target.isMain && !target.ctxId) throw new Error("that frame has no live execution context — run the frames command and retry");
      await ensureHelper(tabId, target.ctxId);
      const expr = "__ybaDriver.snapshot(" + (Number(params.maxNodes) || 100) + "," + (params.includeText !== false) + ")";
      const snap = target.ctxId == null ? await evalInPage(tabId, expr) : await evalInContext(tabId, target.ctxId, expr);
      snap.tabId = tabId;
      if (!target.isMain) snap.frame = target.index;
      return snap;
    }

    case "click":
    case "hover": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const sel = String(params.selector);
      if (!sel) throw new Error("click/hover requires a selector");
      const target = await resolveFrameTarget(tabId, params);
      const isHover = cmd === "hover";
      const useJs = params.method === "js";
      const double = params.double === true || params.clickCount === 2;
      const btn = params.button || "left";

      if (target.crossOrigin) {
        // Cross-origin frames can't be scripted, but trusted pointer events are
        // hit-tested by the browser and route into the frame's own process —
        // click by coordinates inside the frame's box (see AGENT-INSTRUCTIONS).
        if (useJs) throw new Error("method:\"js\" needs a scriptable frame — for cross-origin frames click by coordinates instead: {\"frame\": <iframe selector or listing index>, \"point\": {\"fx\":0.5,\"fy\":0.5}}");
        const g = await globalPointFor(tabId, params, target, null);
        if (isHover) {
          await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: g.x, y: g.y });
          await sleep(150);
          return { hovered: true, method: g.method, x: g.x, y: g.y, frame: target.selector };
        }
        await inputMouse(tabId, g.x, g.y, btn, double);
        return { clicked: true, method: g.method, x: g.x, y: g.y, crossOrigin: true, frame: target.selector, box: g.box };
      }

      if (!target.isMain && !target.ctxId) throw new Error("that frame has no live execution context — run the frames command and retry");
      await ensureHelper(tabId, target.ctxId);
      const runInTarget = (expr) => (target.ctxId == null ? evalInPage(tabId, expr) : evalInContext(tabId, target.ctxId, expr));

      if (useJs) {
        if (isHover) throw new Error("hover cannot use method:\"js\" — it needs real pointer events");
        const r = await runInTarget("__ybaDriver.jsClick(" + JSON.stringify(sel) + ")");
        if (!r || !r.found) throw new Error("selector matched nothing: " + sel);
        return { clicked: true, method: "js", tag: r.tag, role: r.role };
      }

      // trusted pointer path: unobstructed point inside the element, then
      // convert frame-local coordinates to top-level viewport coordinates
      const local = await runInTarget("__ybaDriver.trustedPoint(" + JSON.stringify(sel) + ")");
      const g = await globalPointFor(tabId, params, target, local);
      if (isHover) {
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: g.x, y: g.y });
        await sleep(150);
        return { hovered: true, method: g.method, x: g.x, y: g.y, tag: local.tag, role: local.role };
      }
      await inputMouse(tabId, g.x, g.y, btn, double);
      return { clicked: true, method: g.method, x: g.x, y: g.y, tag: local.tag, role: local.role };
    }

    case "fill":
    case "type": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const sel = String(params.selector);
      if (!sel) throw new Error("fill requires a selector");
      const value = params.value == null ? (params.text == null ? "" : String(params.text)) : String(params.value);
      const target = await resolveFrameTarget(tabId, params);
      if (target.crossOrigin) throw new Error("cannot fill inside a cross-origin frame (Chrome's extension debugger API cannot script out-of-process frames) — same-origin iframes are fully supported");
      if (!target.isMain && !target.ctxId) throw new Error("that frame has no live execution context — run the frames command and retry");
      await ensureHelper(tabId, target.ctxId);
      const useJs = params.method === "js";
      // In a sub-frame we always use the JavaScript fill path (trusted CDP text
      // insertion cannot be routed into cross-origin/out-of-process iframes).
      if (useJs || !target.isMain) {
        const r = target.ctxId == null
          ? await evalInPage(tabId, "__ybaDriver.fillValue(" + JSON.stringify(sel) + "," + JSON.stringify(value) + ")")
          : await evalInContext(tabId, target.ctxId, "__ybaDriver.fillValue(" + JSON.stringify(sel) + "," + JSON.stringify(value) + ")");
        if (!r || !r.found) throw new Error((r && r.reason) || "selector matched nothing: " + sel);
        return { filled: true, method: r.method || "js", tabId };
      }
      const p = await evalInPage(tabId, "__ybaDriver.prepareFill(" + JSON.stringify(sel) + ")");
      if (!p || !p.found) throw new Error("selector matched nothing: " + sel);
      if (p.kind === "select") {
        const r = await evalInPage(tabId, "__ybaDriver.setSelect(" + JSON.stringify(sel) + "," + JSON.stringify(value) + ")");
        if (r && !r.matched) throw new Error("no <option> in that select matches '" + value + "' — use the selectOptions command to list valid options");
        return { filled: true, method: "select", label: r && r.label, value: r && r.value, tabId };
      }
      if (p.kind === "check") {
        const r = await evalInPage(tabId, "__ybaDriver.setChecked(" + JSON.stringify(sel) + "," + JSON.stringify(value) + ")");
        return { filled: true, method: "check", checked: r && r.checked, tabId };
      }
      if (p.kind === "file") throw new Error(sel + " is a file input — use the upload command with a local file path");
      if (p.kind === "input" || p.kind === "editable") {
        await cdp(tabId, "Input.insertText", { text: value });
        return { filled: true, method: "cdp-insertText", tabId };
      }
      throw new Error("element is not fillable (tag " + p.tag + ") — click it first if it is a custom widget");
    }

    case "selectOptions": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const sel = String(params.selector);
      if (!sel) throw new Error("selectOptions requires a selector");
      const target = await resolveFrameTarget(tabId, params);
      if (target.crossOrigin) throw new Error("cannot read a <select> inside a cross-origin frame (Chrome's extension debugger API cannot script out-of-process frames)");
      if (!target.isMain && !target.ctxId) throw new Error("that frame has no live execution context — run the frames command and retry");
      await ensureHelper(tabId, target.ctxId);
      const r = target.ctxId == null
        ? await evalInPage(tabId, "__ybaDriver.selectOptions(" + JSON.stringify(sel) + ")")
        : await evalInContext(tabId, target.ctxId, "__ybaDriver.selectOptions(" + JSON.stringify(sel) + ")");
      if (!r || !r.found) throw new Error("selector matched nothing or is not a <select>: " + sel);
      return { tabId, multiple: r.multiple, selectedIndex: r.selected, options: r.options };
    }

    case "press": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const target = await resolveFrameTarget(tabId, params);
      if (target.crossOrigin) throw new Error("cannot send keys into a cross-origin frame (Chrome's extension debugger API cannot script out-of-process frames) — same-origin iframes are fully supported");
      if (!target.isMain && !target.ctxId) throw new Error("that frame has no live execution context — run the frames command and retry");
      await ensureHelper(tabId, target.ctxId);
      if (params.selector) {
        const sel = String(params.selector);
        const p = target.ctxId == null
          ? await evalInPage(tabId, "__ybaDriver.prepareFill(" + JSON.stringify(sel) + ")")
          : await evalInContext(tabId, target.ctxId, "__ybaDriver.prepareFill(" + JSON.stringify(sel) + ")");
        if (!p || !p.found) throw new Error("selector matched nothing: " + sel);
      }
      const key = String(params.key == null ? "Enter" : params.key);
      const seq = keyEventsFor(key, params.modifiers);
      if (seq.fallbackText) {
        await cdp(tabId, "Input.insertText", { text: seq.fallbackText });
        return { pressed: key, method: "insertText" };
      }
      await dispatchKeySequence(tabId, seq.events);
      return { pressed: key, modifiers: params.modifiers || [] };
    }

    case "evaluate": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const expr = String(params.expression || "");
      if (!expr) throw new Error("evaluate requires an expression");
      const target = await resolveFrameTarget(tabId, params);
      if (target.crossOrigin) throw new Error("cannot evaluate inside a cross-origin frame (Chrome's extension debugger API cannot script out-of-process frames) — same-origin iframes are fully supported");
      if (!target.isMain && !target.ctxId) throw new Error("that frame has no live execution context — run the frames command and retry");
      const value = target.ctxId == null ? await evalInPage(tabId, expr) : await evalInContext(tabId, target.ctxId, expr);
      return { value, tabId };
    }

    case "waitFor": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const session = sessions.get(tabId);
      const target = await resolveFrameTarget(tabId, params);
      if (target.crossOrigin) throw new Error("cannot waitFor inside a cross-origin frame (Chrome's extension debugger API cannot script out-of-process frames)");
      const timeoutMs = Number(params.timeoutMs) || 30000;
      const deadline = Date.now() + timeoutMs;
      const expr = params.expr;
      const text = params.text;
      const selector = params.selector;
      const urlContains = params.urlContains;
      const dialogGone = params.dialogGone === true;
      if (expr == null && text == null && selector == null && urlContains == null && !dialogGone) {
        throw new Error("waitFor needs one of: expr, text, selector, urlContains, dialogGone");
      }
      const cond = async () => {
        if (dialogGone) return !session.dialog;
        // re-resolve the frame's execution context each poll: navigations
        // invalidate it, and right after a navigation it may not exist yet
        let ctx = session.frameCtx.get(target.frameId) || null;
        if (!ctx && !target.isMain) ctx = await getCtxId(tabId, target.frameId, 120);
        const run = (e) => (ctx ? evalInContext(tabId, ctx, e) : evalInPage(tabId, e));
        if (expr != null) { try { return !!(await run(String(expr))); } catch (_) { return false; } }
        if (text != null) { try { return String(await run("document.body ? (document.body.innerText || '') : ''")).includes(String(text)); } catch (_) { return false; } }
        if (urlContains != null) { try { return String(await run("location.href")).includes(String(urlContains)); } catch (_) { return false; } }
        if (selector != null) {
          await ensureHelper(tabId, ctx).catch(() => { });
          try { return !!(await run("__ybaDriver.visible(" + JSON.stringify(String(selector)) + ")")); } catch (_) { return false; }
        }
        return false;
      };
      for (;;) {
        if (await cond()) return { matched: true, waitedMs: timeoutMs - (deadline - Date.now()) };
        if (Date.now() > deadline) throw new Error("waitFor timed out after " + timeoutMs + "ms");
        await sleep(200);
      }
    }

    case "scroll": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const target = await resolveFrameTarget(tabId, params);
      if (target.crossOrigin) throw new Error("cannot scroll inside a cross-origin frame (Chrome's extension debugger API cannot script out-of-process frames)");
      if (!target.isMain && !target.ctxId) throw new Error("that frame has no live execution context — run the frames command and retry");
      await ensureHelper(tabId, target.ctxId);
      const run = (e) => (target.ctxId ? evalInContext(tabId, target.ctxId, e) : evalInPage(tabId, e));
      if (params.selector) {
        const r = await run("__ybaDriver.rect(" + JSON.stringify(String(params.selector)) + ")");
        if (!r || !r.found) throw new Error("selector matched nothing: " + params.selector);
        return { scrolled: true, x: Math.round(r.x), y: Math.round(r.y), tabId };
      }
      if (params.x != null || params.y != null) {
        const dx = Number(params.x) || 0, dy = Number(params.y) || 0;
        await run("window.scrollBy(" + dx + "," + dy + ")");
        const pos = await run("({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })");
        return { scrolled: true, x: pos && pos.x, y: pos && pos.y, tabId };
      }
      const dir = params.direction || "down";
      const amt = Number(params.amount) || 0;
      const expr = amt > 0
        ? "window.scrollBy(0," + (dir === "up" ? -amt : amt) + ")"
        : "window.scrollBy(0," + (dir === "up" ? "-window.innerHeight*0.8" : "window.innerHeight*0.8") + ")";
      await run(expr);
      const pos = await run("({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })");
      return { scrolled: true, x: pos && pos.x, y: pos && pos.y, tabId };
    }

    case "upload": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const sel = String(params.selector);
      if (!sel) throw new Error("upload requires a selector");
      const files = Array.isArray(params.files) ? params.files.map(String) : [String(params.files)];
      if (!files.length || !files[0]) throw new Error("upload requires files: an absolute path or array of paths");
      const target = await resolveFrameTarget(tabId, params);
      if (target.crossOrigin) throw new Error("cannot upload into a cross-origin frame (Chrome's extension debugger API cannot script out-of-process frames)");
      if (!target.isMain && !target.ctxId) throw new Error("that frame has no live execution context — run the frames command and retry");
      await ensureHelper(tabId, target.ctxId);
      const probeExpr = `(() => { const el = __ybaDriver.rawFind(${JSON.stringify(sel)}); if (!el) return { found: false }; return { found: true, isFile: el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file' }; })()`;
      const probe = target.ctxId == null ? await evalInPage(tabId, probeExpr) : await evalInContext(tabId, target.ctxId, probeExpr);
      if (!probe || !probe.found) throw new Error("selector matched nothing: " + sel);
      if (!probe.isFile) throw new Error(sel + " is not an <input type=\"file\"> — nothing to upload to");
      const objRes = await cdp(tabId, "Runtime.evaluate", {
        expression: "__ybaDriver.rawFind(" + JSON.stringify(sel) + ")",
        ...(target.ctxId ? { contextId: target.ctxId } : {}),
        returnByValue: false,
      });
      const objectId = objRes.result && objRes.result.objectId;
      if (!objectId) throw new Error("could not resolve the file input's DOM node");
      // navigations reset the DOM agent — re-arm it before mapping the node
      try { await cdp(tabId, "DOM.enable"); } catch (_) { }
      try { await cdp(tabId, "DOM.getDocument", {}); } catch (_) { }
      const dom = await cdp(tabId, "DOM.requestNode", { objectId });
      if (!dom || !dom.nodeId) throw new Error("could not resolve the file input's node id");
      await cdp(tabId, "DOM.setFileInputFiles", { nodeId: dom.nodeId, files });
      return { uploaded: true, files, tabId };
    }

    case "screenshot": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const fmt = params.format === "jpeg" ? "jpeg" : params.format === "webp" ? "webp" : "png";
      const res = await cdp(tabId, "Page.captureScreenshot", {
        format: fmt,
        fromSurface: true,
        ...(fmt === "jpeg" && params.quality ? { quality: Number(params.quality) } : {}),
        ...(params.fullPage ? { captureBeyondViewport: true } : {}),
      });
      return { data: res.data, format: fmt, tabId };
    }

    case "pdf": {
      const tabId = await resolveTargetTab(params);
      await ensureDebug(tabId);
      const res = await cdp(tabId, "Page.printToPDF", {
        printBackground: params.printBackground !== false,
        landscape: params.landscape === true,
        ...(params.scale ? { scale: Number(params.scale) } : {}),
      }).catch((e) => { throw new Error("printToPDF failed: " + (e && e.message || e)); });
      return { data: res.data, format: "pdf", tabId };
    }

    case "dialog": {
      const tabId = await resolveTargetTab(params);
      const session = sessions.get(tabId);
      if (!session || !session.dialog) return { open: false };
      const accept = params.accept !== false;
      // snapshot fields before the Closed event (which races the accept call) nulls them
      const info = { type: session.dialog.type, message: session.dialog.message, defaultPrompt: session.dialog.defaultPrompt };
      const promptText = params.promptText != null ? String(params.promptText) : info.defaultPrompt;
      session.dialog = null;
      await cdp(tabId, "Page.handleJavaScriptDialog", { accept, promptText });
      return { open: true, handled: true, accept, type: info.type, message: info.message };
    }

    default:
      throw new Error("unknown command: " + cmd + " — see AGENT-INSTRUCTIONS.md for the command list");
  }
}

/* ------------------------------- lifecycle -------------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(() => { connect(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  if (!manualDisconnect && (!ws || ws.readyState > WebSocket.OPEN)) connect();
  // detach any tab's debugger session after 2 minutes idle so the "started
  // debugging" bar disappears — each tab tracked independently so an idle
  // tab from one agent doesn't get kept alive (or killed) by another agent's activity.
  for (const [tabId, s] of sessions) {
    if (Date.now() - s.lastActivity > 120000) detachDebug(tabId);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "ybaConnect") { connect(); sendResponse({ ok: true }); }
  else if (msg.type === "ybaDisconnect") { disconnect(); sendResponse({ ok: true }); }
  else if (msg.type === "ybaSetUrl") {
    setRelayUrl(String(msg.url || DEFAULT_RELAY_URL)).then(() => {
      if (ws) { try { ws.close(); } catch (_) { } ws = null; }
      connected = false;
      connect();
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "ybaGetState") {
    getRelayUrl().then((u) => sendResponse({ connected, url: ws ? ws.url : null, configuredUrl: u, lastTabId, manualDisconnect }));
    return true;
  }
  return undefined;
});

chrome.tabs.onActivated.addListener((info) => { lastTabId = info.tabId; });
chrome.tabs.onCreated.addListener((tab) => { if (tab.id) lastTabId = tab.id; });
chrome.tabs.onRemoved.addListener((tabId) => {
  if (lastTabId === tabId) lastTabId = null;
  sessions.delete(tabId);
});
chrome.debugger.onDetach.addListener((source) => {
  sessions.delete(source.tabId);
});

connect();
