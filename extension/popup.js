"use strict";

const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle");
const urlInput = document.getElementById("url");

let timer = null;
let currentlyConnected = false;

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "ybaGetState" }).catch(() => null);
  const cfg = (st && st.configuredUrl) || "ws://127.0.0.1:7799/ext";
  urlInput.value = cfg;
  currentlyConnected = !!(st && st.connected);

  toggleBtn.disabled = false;
  toggleBtn.classList.toggle("connected", currentlyConnected);
  if (currentlyConnected) {
    statusEl.className = "status ok";
    statusEl.textContent = "Connected — ready to automate";
    toggleBtn.textContent = "Disconnect";
  } else if (st && st.manualDisconnect) {
    statusEl.className = "status";
    statusEl.textContent = "Disconnected";
    toggleBtn.textContent = "Connect";
  } else {
    statusEl.className = "status bad";
    statusEl.textContent = "Not connected";
    toggleBtn.textContent = "Connect";
  }
}

toggleBtn.addEventListener("click", async () => {
  toggleBtn.disabled = true;
  if (currentlyConnected) {
    await chrome.runtime.sendMessage({ type: "ybaDisconnect" }).catch(() => { });
  } else {
    const url = urlInput.value.trim();
    await chrome.runtime.sendMessage({ type: "ybaSetUrl", url }).catch(() => { });
    await new Promise((r) => setTimeout(r, 1200));
  }
  await refresh();
});

// keep the status live while the popup is open
refresh();
clearInterval(timer);
timer = setInterval(refresh, 2000);
window.addEventListener("unload", () => clearInterval(timer));

