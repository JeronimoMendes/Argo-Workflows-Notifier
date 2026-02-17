/* global ArgoNotifierShared, chrome */
"use strict";

const shared = ArgoNotifierShared;

const pageStateEl = document.getElementById("page-state");
const workflowNameEl = document.getElementById("workflow-name");
const toggleWatchBtn = document.getElementById("toggle-watch");
const watchListEl = document.getElementById("watch-list");
const emptyStateEl = document.getElementById("empty-state");

let activeTab = null;
let activeContext = null;
let currentWatch = null;

function runtimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function tabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_error) {
    return null;
  }
}

async function ensureContentScriptInjected(tab) {
  if (!tab || typeof tab.id !== "number") {
    return false;
  }
  if (!shared.isWorkflowRunUrl(tab.url || "")) {
    return false;
  }

  const existing = await tabMessage(tab.id, { type: "GET_WORKFLOW_CONTEXT" });
  if (existing && existing.ok) {
    return true;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/lib/workflow.js", "src/content.js"]
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function setWorkflowControls(enabled, buttonText) {
  toggleWatchBtn.disabled = !enabled;
  toggleWatchBtn.textContent = buttonText;
}

function formatWatchMeta(watch) {
  const phase = watch.lastPhase && watch.lastPhase !== "unknown" ? watch.lastPhase : "waiting";
  return watch.workflowKey + " | last: " + phase;
}

function renderWatchList(watches) {
  watchListEl.innerHTML = "";
  if (!watches || watches.length === 0) {
    emptyStateEl.style.display = "block";
    return;
  }

  emptyStateEl.style.display = "none";
  for (const watch of watches) {
    const li = document.createElement("li");
    li.className = "watch-item";

    const main = document.createElement("div");
    main.className = "watch-main";

    const name = document.createElement("span");
    name.className = "watch-name";
    name.textContent = watch.displayName;

    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "stop-btn";
    stopBtn.textContent = "Stop";
    stopBtn.dataset.watchId = watch.watchId;

    main.appendChild(name);
    main.appendChild(stopBtn);

    const meta = document.createElement("div");
    meta.className = "watch-meta";
    meta.textContent = formatWatchMeta(watch);

    li.appendChild(main);
    li.appendChild(meta);
    watchListEl.appendChild(li);
  }
}

async function refreshWatches() {
  const result = await runtimeMessage({ type: "WATCH_LIST" });
  const watches = result && result.ok ? result.watches || [] : [];
  renderWatchList(watches);
  if (activeTab) {
    currentWatch = watches.find((watch) => watch.tabId === activeTab.id) || null;
  } else {
    currentWatch = null;
  }
}

async function initActiveTabContext() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs && tabs[0] ? tabs[0] : null;
  if (!activeTab) {
    pageStateEl.textContent = "No active tab.";
    workflowNameEl.textContent = "No workflow selected";
    setWorkflowControls(false, "Enable notifications");
    return;
  }

  if (!shared.isWorkflowRunUrl(activeTab.url || "")) {
    pageStateEl.textContent = "Open an Argo workflow run page.";
    workflowNameEl.textContent = "No workflow selected";
    setWorkflowControls(false, "Enable notifications");
    return;
  }

  await ensureContentScriptInjected(activeTab);

  const context = await tabMessage(activeTab.id, { type: "GET_WORKFLOW_CONTEXT" });
  if (!context || !context.ok) {
    pageStateEl.textContent = "Could not read workflow page.";
    workflowNameEl.textContent = "No workflow selected";
    setWorkflowControls(false, "Enable notifications");
    return;
  }

  activeContext = context;
  workflowNameEl.textContent = context.displayName || context.workflowKey;
  pageStateEl.textContent = "Workflow page detected.";
}

async function refreshCurrentWatchState() {
  await refreshWatches();
  if (currentWatch) {
    setWorkflowControls(true, "Disable notifications");
  } else if (activeContext && activeTab) {
    setWorkflowControls(true, "Enable notifications");
  } else {
    setWorkflowControls(false, "Enable notifications");
  }
}

async function toggleWatch() {
  if (!activeTab || !activeContext) {
    return;
  }

  toggleWatchBtn.disabled = true;
  if (currentWatch) {
    await runtimeMessage({ type: "WATCH_DISABLE", watchId: currentWatch.watchId });
  } else {
    await runtimeMessage({
      type: "WATCH_ENABLE",
      tabId: activeTab.id,
      workflowKey: activeContext.workflowKey,
      displayName: activeContext.displayName || activeContext.workflowKey,
      notifyOnSuccess: true,
      notifyOnFailure: true
    });
  }

  await refreshCurrentWatchState();
}

watchListEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (!target.classList.contains("stop-btn")) {
    return;
  }
  const watchId = target.dataset.watchId;
  if (!watchId) {
    return;
  }
  await runtimeMessage({ type: "WATCH_DISABLE", watchId });
  await refreshCurrentWatchState();
});

toggleWatchBtn.addEventListener("click", () => {
  toggleWatch().catch(() => {
    toggleWatchBtn.disabled = false;
  });
});

async function init() {
  await initActiveTabContext();
  await refreshCurrentWatchState();
}

init().catch(() => {
  pageStateEl.textContent = "Failed to initialize popup.";
  setWorkflowControls(false, "Enable notifications");
});
