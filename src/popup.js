/* global ArgoNotifierShared, chrome */
"use strict";

const shared = ArgoNotifierShared;

const pageStateEl = document.getElementById("page-state");
const soundMuteBtnEl = document.getElementById("sound-mute-btn");
const soundVolumeEl = document.getElementById("sound-volume");
const volumeLabelEl = document.getElementById("volume-label");
const workflowNameEl = document.getElementById("workflow-name");
const workflowNameLabelEl = document.getElementById("workflow-name-label");
const toggleWatchBtn = document.getElementById("toggle-watch");
const watchListEl = document.getElementById("watch-list");
const emptyStateEl = document.getElementById("empty-state");

let activeTab = null;
let activeContext = null;
let currentWatch = null;
let watchIndex = new Map();
const MAX_TITLE_LEN = 56;
const MAX_WATCH_NAME_LEN = 42;
const MAX_WATCH_META_LEN = 60;

function truncateWithEllipsis(value, maxLength) {
  const text = String(value || "");
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(0, maxLength - 3)) + "...";
}

async function runtimeMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
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
  if (!toggleWatchBtn) {
    return;
  }
  toggleWatchBtn.disabled = !enabled;
  toggleWatchBtn.textContent = buttonText;
}

function setWorkflowTitle(title, isRenameEnabled) {
  if (!workflowNameLabelEl || !workflowNameEl) {
    return;
  }
  const fullTitle = title || "No workflow selected";
  workflowNameLabelEl.textContent = truncateWithEllipsis(fullTitle, MAX_TITLE_LEN);
  workflowNameEl.disabled = !isRenameEnabled;
  workflowNameEl.classList.toggle("rename-enabled", isRenameEnabled);
  workflowNameEl.title = isRenameEnabled
    ? fullTitle + " (click to rename this watched workflow)"
    : fullTitle;
}

function formatWatchMeta(watch) {
  const phase = watch.lastPhase && watch.lastPhase !== "unknown" ? watch.lastPhase : "waiting";
  return truncateWithEllipsis(watch.workflowKey + " | last: " + phase, MAX_WATCH_META_LEN);
}

function renderWatchList(watches) {
  if (!watchListEl || !emptyStateEl) {
    return;
  }
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

    const name = document.createElement("button");
    name.type = "button";
    name.className = "watch-name-btn";
    name.textContent = truncateWithEllipsis(watch.displayName, MAX_WATCH_NAME_LEN);
    name.title = watch.displayName + " (open workflow tab)";
    name.dataset.watchId = watch.watchId;

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
  watchIndex = new Map(watches.map((watch) => [watch.watchId, watch]));
  renderWatchList(watches);
  if (activeTab) {
    currentWatch = watches.find((watch) => watch.tabId === activeTab.id) || null;
  } else {
    currentWatch = null;
  }
}

async function initActiveTabContext() {
  if (!pageStateEl) {
    return;
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs && tabs[0] ? tabs[0] : null;
  if (!activeTab) {
    pageStateEl.textContent = "No active tab.";
    setWorkflowTitle("No workflow selected", false);
    setWorkflowControls(false, "Enable notifications");
    return;
  }

  if (!shared.isWorkflowRunUrl(activeTab.url || "")) {
    pageStateEl.textContent = "Open an Argo workflow run page.";
    setWorkflowTitle("No workflow selected", false);
    setWorkflowControls(false, "Enable notifications");
    return;
  }

  await ensureContentScriptInjected(activeTab);

  const context = await tabMessage(activeTab.id, { type: "GET_WORKFLOW_CONTEXT" });
  if (!context || !context.ok) {
    pageStateEl.textContent = "Could not read workflow page.";
    setWorkflowTitle("No workflow selected", false);
    setWorkflowControls(false, "Enable notifications");
    return;
  }

  activeContext = context;
  setWorkflowTitle(context.displayName || context.workflowKey, false);
  pageStateEl.textContent = "Workflow page detected.";
}

async function refreshCurrentWatchState() {
  await refreshWatches();
  if (currentWatch) {
    setWorkflowTitle(currentWatch.displayName || currentWatch.workflowKey, true);
    setWorkflowControls(true, "Disable notifications");
  } else if (activeContext && activeTab) {
    setWorkflowTitle(activeContext.displayName || activeContext.workflowKey, false);
    setWorkflowControls(true, "Enable notifications");
  } else {
    setWorkflowTitle("No workflow selected", false);
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

async function renameWatchWithPrompt(watch) {
  if (!watch || !watch.watchId) {
    return;
  }
  const nextName = prompt("Rename watched workflow", watch.displayName || watch.workflowKey);
  if (nextName === null) {
    return;
  }
  const trimmed = nextName.trim();
  if (!trimmed) {
    return;
  }

  const result = await runtimeMessage({
    type: "WATCH_RENAME",
    watchId: watch.watchId,
    displayName: trimmed
  });
  if (!result || !result.ok || !result.watch) {
    if (pageStateEl) {
      pageStateEl.textContent = "Rename failed. Refresh extension and try again.";
    }
    return;
  }

  if (pageStateEl) {
    pageStateEl.textContent = "Workflow page detected.";
  }
  await refreshCurrentWatchState();
}

if (watchListEl) {
  watchListEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.classList.contains("stop-btn")) {
      const watchId = target.dataset.watchId;
      if (!watchId) {
        return;
      }
      await runtimeMessage({ type: "WATCH_DISABLE", watchId });
      await refreshCurrentWatchState();
      return;
    }

    if (target.classList.contains("watch-name-btn")) {
      const watchId = target.dataset.watchId;
      if (!watchId) {
        return;
      }
      const watch = watchIndex.get(watchId);
      if (!watch) {
        return;
      }
      try {
        const tab = await chrome.tabs.update(watch.tabId, { active: true });
        if (tab && typeof tab.windowId === "number") {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        window.close();
      } catch (_error) {
        if (pageStateEl) {
          pageStateEl.textContent = "Could not open workflow tab.";
        }
      }
    }
  });
}

if (toggleWatchBtn) {
  toggleWatchBtn.addEventListener("click", () => {
    toggleWatch().catch(() => {
      toggleWatchBtn.disabled = false;
    });
  });
}

if (workflowNameEl) {
  workflowNameEl.addEventListener("click", async () => {
    if (!currentWatch) {
      return;
    }
    await renameWatchWithPrompt(currentWatch);
  });
}

async function initSoundSettings() {
  if (!soundMuteBtnEl || !soundVolumeEl || !volumeLabelEl) {
    return;
  }

  const { soundMuted = false, soundVolume = 1 } = await chrome.storage.local.get([
    "soundMuted",
    "soundVolume"
  ]);

  let muted = soundMuted;
  const pct = Math.round(soundVolume * 100);
  soundVolumeEl.value = String(pct);
  volumeLabelEl.textContent = pct + "%";
  soundMuteBtnEl.textContent = muted ? "🔇" : "🔊";
  soundVolumeEl.classList.toggle("sound-slider-muted", muted);

  soundMuteBtnEl.addEventListener("click", async () => {
    muted = !muted;
    soundMuteBtnEl.textContent = muted ? "🔇" : "🔊";
    soundVolumeEl.classList.toggle("sound-slider-muted", muted);
    await chrome.storage.local.set({ soundMuted: muted });
  });

  soundVolumeEl.addEventListener("input", async () => {
    const value = Number(soundVolumeEl.value);
    volumeLabelEl.textContent = value + "%";
    await chrome.storage.local.set({ soundVolume: value / 100 });
  });
}

function initDevPanel() {
  const devPanel = document.getElementById("dev-panel");
  if (!devPanel) {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (!params.has("dev")) {
    return;
  }
  devPanel.style.display = "";

  const successBtn = document.getElementById("dev-notify-success");
  const failureBtn = document.getElementById("dev-notify-failure");

  if (successBtn) {
    successBtn.addEventListener("click", () => {
      runtimeMessage({ type: "DEV_FIRE_NOTIFICATION", outcome: "success" }).catch(() => {});
    });
  }
  if (failureBtn) {
    failureBtn.addEventListener("click", () => {
      runtimeMessage({ type: "DEV_FIRE_NOTIFICATION", outcome: "failure" }).catch(() => {});
    });
  }
}

async function init() {
  if (
    !pageStateEl ||
    !workflowNameEl ||
    !workflowNameLabelEl ||
    !toggleWatchBtn ||
    !watchListEl ||
    !emptyStateEl
  ) {
    return;
  }
  initDevPanel();
  await initSoundSettings();
  await initActiveTabContext();
  await refreshCurrentWatchState();
}

init().catch(() => {
  if (pageStateEl) {
    pageStateEl.textContent = "Failed to initialize popup.";
  }
  setWorkflowTitle("No workflow selected", false);
  setWorkflowControls(false, "Enable notifications");
});
