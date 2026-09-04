#!/usr/bin/env node
/**
 * End-to-end test for Your Browser Agent v3.
 *
 * Spawns: an isolated relay (port 7911), two static HTTP servers
 * (127.0.0.1:8321 same-origin main+iframe, localhost:8322 cross-origin
 * iframe), and a throwaway Edge/Chrome profile with the extension loaded
 * from a TEMP COPY whose default relay URL is rewritten to :7911 (so the
 * test instance can never hijack a relay already running on the default
 * port).
 *
 * Exercises the full agent command surface: tabs, snapshot, trusted click,
 * fill, selects, checkboxes, hover, hotkeys, waitFor, scroll, dialogs
 * (alert/prompt), upload, screenshots, same-origin iframes (snapshot/click/
 * fill/select), cross-origin iframes (listing + coordinate clicks), history
 * navigation, PDF, closeTab.
 *
 * Usage:  node scripts/e2e.mjs            (set CHROME to override the binary)
 */
"use strict";

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const RELAY_PORT = 7911;
const MAIN_PORT = 8321;
const FRAME_PORT = 8322;
const RELAY_URL = "ws://127.0.0.1:" + RELAY_PORT + "/ext";
const DEBUG_PORT = 9333;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (extra && !ok ? "  -> " + extra : ""));
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch (_) { j = { ok: false, error: "non-JSON response " + res.status }; }
  return j;
}

let extBase = "http://127.0.0.1:" + RELAY_PORT;
async function cmd(name, params, opts = {}) {
  const j = await postJSON(extBase + "/cmd", { cmd: name, params: params || {} });
  const expectOk = opts.expectOk !== false;
  if (j && j.ok === expectOk) return j;
  throw new Error("cmd " + name + " unexpected result: " + JSON.stringify(j).slice(0, 300));
}
async function tryCmd(name, params) {
  return postJSON(extBase + "/cmd", { cmd: name, params: params || {} });
}
async function waitForStatus(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(extBase + "/status");
      const j = await r.json();
      if (j && j.extension) return j;
    } catch (_) { }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (_) { }
    await sleep(200);
  }
  throw new Error("poll timed out: " + label + " (last=" + JSON.stringify(last).slice(0, 200) + ")");
}

/* --------------------------------- pages ---------------------------------- */

const MAIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>YBA Test Page</title></head><body>
<h1 id="title">Your Browser Agent Test</h1>
<button id="btn">Click Me</button>
<input id="name" placeholder="Your name">
<textarea id="notes"></textarea>
<select id="color"><option value="">Pick…</option><option value="red">Cherry Red</option><option value="grn">Forest Green</option><option value="blu">Ocean Blue</option></select>
<label><input type="checkbox" id="agree"> I agree</label>
<input type="radio" name="plan" value="free" id="planfree"> Free
<input type="radio" name="plan" value="pro" id="planpro"> Pro
<div id="hoverel" style="width:140px;height:44px;background:#eee;display:inline-block;border:1px solid #999">hover target</div>
<input type="file" id="file">
<button id="alertbtn">Open alert</button>
<button id="promptbtn">Open prompt</button>
<button id="linkbtn" onclick="location.href='/page2.html'">Go to page 2</button>
<iframe id="frame1" src="/frame.html" style="width:420px;height:200px;border:1px solid #333"></iframe>
<iframe id="frame2" src="http://localhost:${FRAME_PORT}/cross.html" style="width:420px;height:200px;border:1px solid #900"></iframe>
<div id="spacer" style="height:1400px"></div>
<button id="latebtn" style="display:none">Late Button</button>
<div id="frameinfo">no frame msgs</div>
<script>
window.__state={clicks:0,trusted:null,filled:'',hovered:false,frameMsgs:[],alerted:false,prompted:null,agree:false,plan:null};
document.getElementById('btn').addEventListener('click',function(e){__state.clicks++;__state.trusted=e.isTrusted;});
document.getElementById('name').addEventListener('input',function(e){__state.filled=this.value;});
document.getElementById('hoverel').addEventListener('mouseover',function(){__state.hovered=true;});
window.addEventListener('message',function(ev){__state.frameMsgs.push(ev.data);document.getElementById('frameinfo').textContent=JSON.stringify(__state.frameMsgs);});
document.getElementById('alertbtn').addEventListener('click',function(){alert('hello from yba');__state.alerted=true;});
document.getElementById('promptbtn').addEventListener('click',function(){__state.prompted=prompt('What is your name?','default-name');});
document.getElementById('agree').addEventListener('change',function(){__state.agree=this.checked;});
document.querySelectorAll('input[name=plan]').forEach(function(r){r.addEventListener('change',function(){__state.plan=this.value;});});
setTimeout(function(){document.getElementById('latebtn').style.display='inline-block';},1200);
</script></body></html>`;

const PAGE2_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>YBA Page Two</title></head><body><h1>Page Two</h1></body></html>`;

const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>YBA Frame</title></head><body>
<button id="fbtn">Frame Button</button>
<input id="finput" placeholder="frame input">
<select id="fsel"><option value="a">Alpha</option><option value="b">Beta</option></select>
<script>
window.__fc={clicks:0,trusted:null,filled:''};
document.getElementById('fbtn').addEventListener('click',function(e){__fc.clicks++;__fc.trusted=e.isTrusted;parent.postMessage({from:'frame',clicks:__fc.clicks,trusted:e.isTrusted,ts:Date.now()},'*');});
document.getElementById('finput').addEventListener('input',function(){__fc.filled=this.value;});
</script></body></html>`;

const CROSS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>YBA Cross Frame</title></head><body>
<button id="big" style="width:300px;height:120px;margin:30px auto;display:block">BIG CROSS BUTTON</button>
<script>
document.getElementById('big').addEventListener('click',function(e){parent.postMessage({from:'cross',trusted:e.isTrusted,ts:Date.now()},'*');});
</script></body></html>`;

function startServer(port, body) {
  const route = typeof body === "function" ? body : () => body;
  const s = http.createServer((req, res) => {
    const url = typeof req.url === "string" ? req.url : "/";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(route(url));
  });
  return new Promise((resolve) => s.listen(port, "127.0.0.1", () => resolve(s)));
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cands = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
  ];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  throw new Error("Chrome/Edge not found — set CHROME env var");
}

function killTree(pid) {
  try { spawnSync(pid); } catch (_) { }
}

async function main() {
  const chromePath = findChrome();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yba-e2e-"));
  const extCopy = path.join(tmpRoot, "extension");
  const profile = path.join(tmpRoot, "profile");
  fs.cpSync(path.join(REPO, "extension"), extCopy, { recursive: true });

  // rewrite default relay URL + version marker so the test instance is isolated
  let bg = fs.readFileSync(path.join(extCopy, "background.js"), "utf8");
  bg = bg.replace('ws://127.0.0.1:7799/ext', RELAY_URL).replace('"1.0.0"', '"1.0.0-e2e"');
  fs.writeFileSync(path.join(extCopy, "background.js"), bg);

  const uploadFile = path.join(os.tmpdir(), "yba-upload-" + Date.now() + ".txt");
  fs.writeFileSync(uploadFile, "upload me please");

  let relay = null, mainServer = null, frameServer = null, chrome = null;
  let chromeLog = "", relayLog = "";
  try {
    relay = spawn(process.execPath, [path.join(REPO, "relay", "relay.js"), String(RELAY_PORT)], { stdio: ["ignore", "pipe", "pipe"] });
    relay.stderr.on("data", (d) => { relayLog += d; });
    relay.stdout.on("data", (d) => { relayLog += d; });
    mainServer = await startServer(MAIN_PORT, (u) => (u.startsWith("/frame") ? FRAME_HTML : u.startsWith("/page2") ? PAGE2_HTML : MAIN_HTML));
    frameServer = await startServer(FRAME_PORT, () => CROSS_HTML);

    console.log("Launching isolated browser with the extension loaded…");
    chrome = spawn(chromePath, [
      "--user-data-dir=" + profile,
      "--load-extension=" + extCopy,
      "--no-first-run", "--no-default-browser-check",
      "--disable-popup-blocking",
      "--remote-debugging-port=" + DEBUG_PORT,
      "--enable-logging=stderr",
      "--window-size=1280,950",
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
    chrome.stdout.on("data", (d) => { chromeLog += d; });
    chrome.stderr.on("data", (d) => { chromeLog += d; });
    chrome.on("error", (e) => { console.error("browser spawn error:", e.message); });

    console.log("Waiting for the extension to connect to the relay…");
    let status = await waitForStatus(20000);
    if (!status) {
      try { await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json/new?url=http://127.0.0.1:" + MAIN_PORT + "/test.html"); } catch (_) { }
      status = await waitForStatus(25000);
    }
    check("extension connects to relay", !!status, status ? "" : "no /status extension:true within 45s");
    if (!status) {
      console.log("--- relay log ---\n" + (relayLog.slice(0, 2000) || "(empty)"));
      console.log("--- browser log (last 6000) ---\n" + (chromeLog.slice(-6000) || "(empty)"));
      try {
        const list = await (await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json/list")).json();
        console.log("--- debug targets ---");
        for (const t of list) console.log("  ", t.type, "|", (t.title || "").slice(0, 60), "|", (t.url || "").slice(0, 90));
      } catch (_) { }
      return 1;
    }
    check("extension reports v3 engine header", (status.extensionVersion || "").includes("1.0.0"), JSON.stringify(status));
    extBase = "http://127.0.0.1:" + RELAY_PORT;

    /* -------- basics -------- */
    const ping = await cmd("ping");
    check("ping returns pong", ping.ok && ping.result && ping.result.pong === true && ping.result.engine === "cdp-v3", JSON.stringify(ping));
    const tabs = await cmd("tabs");
    check("tabs lists tab(s)", Array.isArray(tabs.result) && tabs.result.length >= 1, JSON.stringify(tabs).slice(0, 200));

    const nt = await cmd("newTab", { url: "http://127.0.0.1:" + MAIN_PORT + "/test.html" });
    const tabId = nt.result.tabId;
    check("newTab opens test page", nt.ok && nt.result.url.includes("test.html"), JSON.stringify(nt).slice(0, 200));

    const snap = await cmd("snapshot");
    const nodes = snap.result.nodes || [];
    const btnRef = (nodes.find((n) => n.role === "button" && n.name === "Click Me") || {}).ref;
    check("snapshot lists Click Me button", !!btnRef, JSON.stringify(snap.result).slice(0, 300));
    check("snapshot carries page url/title", snap.result.url.includes("test.html") && snap.result.title.includes("YBA"), "");

    /* -------- trusted click -------- */
    await cmd("click", { selector: btnRef });
    await poll(async () => (await cmd("evaluate", { expression: "window.__state && window.__state.clicks" })).result.value === 1, 5000, "click counter");
    const trusted = (await cmd("evaluate", { expression: "window.__state.trusted" })).result.value;
    check("trusted click is isTrusted=true", trusted === true, "trusted=" + trusted);

    /* -------- text selectors / css -------- */
    const snap2 = await cmd("snapshot");
    const nameByText = (snap2.result.nodes || []).find((n) => n.name === "Your name");
    check("snapshot lists placeholder-only input", !!nameByText, "");
    const cssClick = await cmd("click", { selector: "css=#btn" });
    check("css= click works", cssClick.ok, JSON.stringify(cssClick).slice(0, 150));
    await poll(async () => (await cmd("evaluate", { expression: "window.__state.clicks" })).result.value === 2, 5000, "2nd click");

    /* -------- fill -------- */
    await cmd("fill", { selector: "#name", value: "Hermes Agent" });
    await poll(async () => (await cmd("evaluate", { expression: "window.__state.filled" })).result.value === "Hermes Agent", 5000, "input event fired");
    check("fill types + fires input events", true, "");

    /* -------- select by label -------- */
    await cmd("fill", { selector: "#color", value: "Ocean Blue" });
    await poll(async () => (await cmd("evaluate", { expression: "document.querySelector('#color').value" })).result.value === "blu", 5000, "select label match");
    check("fill <select> matches option label", true, "");
    const opts = await cmd("selectOptions", { selector: "#color" });
    check("selectOptions lists options", opts.ok && opts.result.options.length === 4 && opts.result.options[1].value === "red" && opts.result.options[1].label === "Cherry Red", JSON.stringify(opts.result).slice(0, 200));
    await cmd("fill", { selector: "#color", value: "grn" });
    check("fill <select> matches option value", (await cmd("evaluate", { expression: "document.querySelector('#color').value" })).result.value === "grn", "");
    const badSel = await tryCmd("fill", { selector: "#color", value: "no-such-option" });
    check("fill <select> with unknown option errors helpfully", badSel.ok === false && /no <option>/.test(badSel.error), JSON.stringify(badSel).slice(0, 200));

    /* -------- checkbox / radio -------- */
    await cmd("fill", { selector: "#agree", value: true });
    check("fill checkbox=true checks it", (await cmd("evaluate", { expression: "window.__state.agree" })).result.value === true, "");
    await cmd("fill", { selector: "#planpro", value: true });
    check("fill radio checks it", (await cmd("evaluate", { expression: "window.__state.plan" })).result.value === "pro", "");

    /* -------- hover -------- */
    await cmd("hover", { selector: "#hoverel" });
    await poll(async () => (await cmd("evaluate", { expression: "window.__state.hovered" })).result.value === true, 5000, "hover");
    check("hover triggers mouseover", true, "");

    /* -------- keys / hotkeys -------- */
    await cmd("click", { selector: "#name" });
    const hot = await tryCmd("press", { key: "a", modifiers: ["Control"] });
    check("hotkey Control+A dispatches", hot.ok, JSON.stringify(hot).slice(0, 150));
    const hot2 = await tryCmd("press", { key: "c", modifiers: ["Control"] });
    check("hotkey Control+C dispatches", hot2.ok, "");
    const kp = await cmd("press", { key: "ArrowLeft" });
    check("press named key ArrowLeft", kp.ok && kp.result.pressed === "ArrowLeft", "");
    const kp2 = await tryCmd("press", { key: "End" });
    check("press End", kp2.ok, "");
    const kp3 = await tryCmd("press", { key: "!", });
    check("press shifted punctuation", kp3.ok, JSON.stringify(kp3).slice(0, 150));

    /* -------- waitFor -------- */
    const wf = await cmd("waitFor", { selector: "#latebtn", timeoutMs: 15000 });
    check("waitFor selector appears (late element)", wf.result.matched === true, JSON.stringify(wf).slice(0, 200));
    await cmd("click", { selector: "#latebtn" });
    const wf2 = await tryCmd("waitFor", { selector: "#never-exists-xyz", timeoutMs: 2500 });
    check("waitFor times out with error", wf2.ok === false && /timed out/.test(wf2.error || ""), JSON.stringify(wf2).slice(0, 150));

    /* -------- evaluate & scroll -------- */
    const ev = await cmd("evaluate", { expression: "document.querySelector('#title').innerText" });
    check("evaluate returns value", ev.result.value === "Your Browser Agent Test", String(ev.result.value));
    const scY = await poll(async () => {
      await cmd("scroll", { direction: "down" });
      const v = (await cmd("evaluate", { expression: "Math.round(window.scrollY)" })).result.value;
      return v > 0 ? v : null;
    }, 8000, "scroll moved page");
    check("scroll down moves page", scY > 0, "y=" + scY);
    await cmd("scroll", { direction: "up", amount: 5000 });
    const sc2 = await cmd("evaluate", { expression: "Math.round(window.scrollY)" });
    check("scroll up returns to top", sc2.result.value < 50, "y=" + sc2.result.value);

    /* -------- screenshot -------- */
    const shot = await cmd("screenshot");
    check("screenshot returns base64 png", shot.ok && typeof shot.result.data === "string" && shot.result.data.startsWith("iVBOR"), "len=" + (shot.result.data || "").length);

    /* -------- upload -------- */
    const up = await cmd("upload", { selector: "#file", files: [uploadFile] });
    check("upload sets file input", up.ok && up.result.uploaded === true, JSON.stringify(up).slice(0, 200));
    const upName = await poll(async () => {
      const r = await cmd("evaluate", { expression: "document.querySelector('#file').files.length ? document.querySelector('#file').files[0].name : ''" });
      return r.result.value ? r.result.value : null;
    }, 5000, "file name");
    check("uploaded file name matches", upName === path.basename(uploadFile), String(upName));

    /* -------- dialogs -------- */
    await cmd("click", { selector: "#alertbtn" });
    await sleep(500);
    const blocked = await tryCmd("snapshot");
    check("open dialog blocks other commands w/ clear error", blocked.ok === false && /dialog/i.test(blocked.error || ""), JSON.stringify(blocked).slice(0, 200));
    const dlg = await cmd("dialog", { accept: true });
    check("dialog accept returns info", dlg.ok && dlg.result.message === "hello from yba", JSON.stringify(dlg.result).slice(0, 200));
    await poll(async () => (await cmd("evaluate", { expression: "window.__state.alerted" })).result.value === true, 5000, "alert dismissed");
    await cmd("click", { selector: "#promptbtn" });
    await sleep(500);
    await cmd("dialog", { accept: true, promptText: "Agent Smith" });
    const prompted = await poll(async () => {
      const v = (await cmd("evaluate", { expression: "window.__state.prompted" })).result.value;
      return v ? v : null;
    }, 5000, "prompt result");
    check("prompt text answered", prompted === "Agent Smith", String(prompted));

    /* -------- navigation -------- */
    await cmd("click", { selector: "#linkbtn" });
    await poll(async () => (await cmd("evaluate", { expression: "location.pathname" })).result.value === "/page2.html", 15000, "navigate to page2");
    const back = await cmd("back");
    check("back returns to previous page", back.ok && back.result.url.includes("test.html"), JSON.stringify(back).slice(0, 200));
    await poll(async () => (await cmd("evaluate", { expression: "document.readyState" })).result.value === "complete", 10000, "back load");
    const fwd = await cmd("forward");
    check("forward goes to page2 again", fwd.ok && fwd.result.url.includes("page2"), JSON.stringify(fwd).slice(0, 200));
    await cmd("back");
    await poll(async () => (await cmd("evaluate", { expression: "document.readyState" })).result.value === "complete", 10000, "back2 load");
    const rel = await cmd("reload");
    check("reload works", rel.ok, JSON.stringify(rel).slice(0, 150));

    /* -------- same-origin iframe: full support -------- */
    const framesRes = await poll(async () => {
      const r = await cmd("frames");
      const fl = (r.result && r.result.frames) || [];
      return fl.length >= 3 ? fl : null;
    }, 15000, "frames list contains sub-frames");
    check("frames lists sub-frames", framesRes.length >= 3, JSON.stringify(framesRes).slice(0, 400));
    const sameIdx = framesRes.findIndex((f) => f.reachable === true && f.index > 0 && (f.url || "").includes("/frame.html"));
    check("same-origin iframe reachable + listed", sameIdx > 0, JSON.stringify(framesRes).slice(0, 400));
    const crossEntry = framesRes.find((f) => f.crossOrigin === true);
    check("cross-origin iframe flagged crossOrigin", !!crossEntry, JSON.stringify(framesRes).slice(0, 400));

    const fsnap = await cmd("snapshot", { frame: sameIdx });
    const fNodes = fsnap.result.nodes || [];
    const fbtnRef = (fNodes.find((n) => n.name === "Frame Button") || {}).ref;
    check("snapshot inside same-origin iframe lists Frame Button", !!fbtnRef, JSON.stringify(fsnap.result).slice(0, 300));

    await cmd("click", { selector: fbtnRef, frame: sameIdx });
    const fmsg = await poll(async () => {
      const msgs = (await cmd("evaluate", { expression: "window.__state.frameMsgs" })).result.value || [];
      return msgs.filter((m) => m && m.from === "frame").length ? msgs : null;
    }, 6000, "same-origin frame postMessage");
    const frameMsg = fmsg.filter((m) => m && m.from === "frame").pop();
    check("trusted click inside same-origin iframe", frameMsg && frameMsg.trusted === true && frameMsg.clicks >= 1, JSON.stringify(fmsg).slice(0, 300));

    await cmd("fill", { selector: "#finput", value: "frame-hello", frame: sameIdx });
    const fval = await poll(async () => {
      const v = (await cmd("evaluate", { expression: "document.querySelector('#finput').value", frame: sameIdx })).result.value;
      return v === "frame-hello" ? v : null;
    }, 5000, "iframe fill");
    check("fill inside same-origin iframe works", fval === "frame-hello", String(fval));

    await cmd("fill", { selector: "#fsel", value: "Beta", frame: sameIdx });
    const fselVal = await poll(async () => {
      const v = (await cmd("evaluate", { expression: "document.querySelector('#fsel').value", frame: sameIdx })).result.value;
      return v === "b" ? v : null;
    }, 5000, "iframe select");
    check("fill <select> inside iframe", fselVal === "b", String(fselVal));

    const xSnap = await tryCmd("snapshot", { frame: crossEntry.index });
    check("snapshot in cross-origin frame errors w/ guidance", xSnap.ok === false && /cross-origin/.test(xSnap.error || ""), JSON.stringify(xSnap).slice(0, 250));

    /* -------- cross-origin iframe: coordinate click -------- */
    const cclick = await cmd("click", { frame: "#frame2", point: { fx: 0.5, fy: 0.5 } });
    check("click into cross-origin iframe by coordinates", cclick.ok && cclick.result.crossOrigin === true, JSON.stringify(cclick).slice(0, 250));
    const cmsg = await poll(async () => {
      const msgs = (await cmd("evaluate", { expression: "window.__state.frameMsgs" })).result.value || [];
      return msgs.find((m) => m && m.from === "cross") || null;
    }, 6000, "cross-origin frame message");
    check("cross-origin iframe click landed + isTrusted", cmsg && cmsg.trusted === true, JSON.stringify(cmsg).slice(0, 300));

    /* -------- pdf (retry once across an MV3 service-worker reconnect) -------- */
    let pdf = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      pdf = await tryCmd("pdf");
      if (pdf.ok) break;
      const st = await waitForStatus(60000);
      if (!st) break;
    }
    check("pdf returns base64", pdf && pdf.ok && (pdf.result.data || "").startsWith("JVBER"), "len=" + (pdf && pdf.result ? (pdf.result.data || "").length : 0) + " err=" + JSON.stringify(pdf).slice(0, 150));

    /* -------- cleanup -------- */
    const ct = await cmd("closeTab", { tabId });
    check("closeTab closes", ct.ok && ct.result.closed === true, "");
    await cmd("ping");

    const failCount = results.filter((r) => !r.ok).length;
    console.log("\n=== " + (results.length - failCount) + "/" + results.length + " checks passed ===");
    return failCount === 0 ? 0 : 1;
  } catch (e) {
    console.error("\nFATAL:", e && e.stack || e);
    return 1;
  } finally {
    try { fs.unlinkSync(uploadFile); } catch (_) { }
    if (chrome) { try { spawn("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { windowsHide: true }); } catch (_) { } }
    try { relay && relay.kill(); } catch (_) { }
    try { mainServer && mainServer.close(); } catch (_) { }
    try { frameServer && frameServer.close(); } catch (_) { }
    setTimeout(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { } }, 500);
  }
}

process.exit(await main());
