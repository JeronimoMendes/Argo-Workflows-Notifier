/* global ArgoNotifierShared, chrome */
"use strict";

if (typeof ArgoNotifierShared === "undefined" && typeof importScripts === "function") {
  importScripts("lib/workflow.js");
}

const shared = globalThis.ArgoNotifierShared;
if (!shared) {
  throw new Error("Failed to initialize shared workflow helpers in background worker.");
}

const ALARM_NAME = "argo-workflow-notifier-poll";
const ALARM_PERIOD_MINUTES = 0.5;
const MAX_MISSES = 3;

let watches = new Map();
let hydrated = false;

async function ensureHydrated() {
  if (hydrated) {
    return;
  }
  await hydrateWatches();
}

async function hydrateWatches() {
  const storage = await chrome.storage.local.get("watches");
  const stored = storage.watches || {};
  watches = new Map();
  for (const [watchId, watch] of Object.entries(stored)) {
    watches.set(watchId, watch);
  }
  hydrated = true;
  await pruneInvalidWatches();
  await syncAlarm();
}

async function persistWatches() {
  await chrome.storage.local.set({ watches: Object.fromEntries(watches) });
}

async function syncAlarm() {
  if (watches.size > 0) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
    return;
  }
  await chrome.alarms.clear(ALARM_NAME);
}

function watchForTabExists(tabId) {
  for (const watch of watches.values()) {
    if (watch.tabId === tabId) {
      return true;
    }
  }
  return false;
}

async function removeWatch(watchId) {
  if (watches.delete(watchId)) {
    await persistWatches();
    await syncAlarm();
    return true;
  }
  return false;
}

async function removeWatchesForTab(tabId) {
  let changed = false;
  for (const [watchId, watch] of watches.entries()) {
    if (watch.tabId === tabId) {
      watches.delete(watchId);
      changed = true;
    }
  }
  if (changed) {
    await persistWatches();
    await syncAlarm();
  }
}

async function pruneInvalidWatches() {
  let changed = false;
  for (const [watchId, watch] of watches.entries()) {
    try {
      const tab = await chrome.tabs.get(watch.tabId);
      if (!tab || !shared.isWorkflowRunUrl(tab.url || "")) {
        watches.delete(watchId);
        changed = true;
      }
    } catch (_error) {
      watches.delete(watchId);
      changed = true;
    }
  }
  if (changed) {
    await persistWatches();
  }
}

async function sendWorkflowNotification(watch, outcome) {
  const title =
    outcome === "success"
      ? "Argo workflow succeeded"
      : "Argo workflow failed";
  const message =
    outcome === "success"
      ? watch.displayName + " finished successfully."
      : watch.displayName + " finished with errors.";

  await chrome.notifications.create("argo-watch-" + watch.watchId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message
  });
}

async function checkOneWatch(watchId, watch) {
  try {
    const tab = await chrome.tabs.get(watch.tabId);
    if (!tab || !shared.isWorkflowRunUrl(tab.url || "")) {
      watches.delete(watchId);
      return true;
    }

    const response = await chrome.tabs.sendMessage(watch.tabId, { type: "GET_WORKFLOW_STATUS" });
    if (!response || !response.workflowKey || !response.phase) {
      const missCount = (watch.missCount || 0) + 1;
      if (missCount >= MAX_MISSES) {
        watches.delete(watchId);
      } else {
        watches.set(watchId, { ...watch, missCount });
      }
      return true;
    }

    if (response.workflowKey !== watch.workflowKey) {
      watches.delete(watchId);
      return true;
    }

    const evaluation = shared.evaluateWatchObservation(
      watch,
      response.phase,
      response.observedAt || Date.now()
    );
    const nextWatch = { ...evaluation.nextWatch, missCount: 0 };

    if (evaluation.isTerminal) {
      if (evaluation.shouldNotify) {
        await sendWorkflowNotification(nextWatch, evaluation.outcome);
      }
      watches.delete(watchId);
      return true;
    }

    watches.set(watchId, nextWatch);
    return true;
  } catch (_error) {
    const missCount = (watch.missCount || 0) + 1;
    if (missCount >= MAX_MISSES) {
      watches.delete(watchId);
    } else {
      watches.set(watchId, { ...watch, missCount });
    }
    return true;
  }
}

async function pollWatches() {
  await ensureHydrated();
  if (watches.size === 0) {
    await syncAlarm();
    return;
  }

  let changed = false;
  for (const [watchId, watch] of Array.from(watches.entries())) {
    const before = JSON.stringify(watches.get(watchId));
    await checkOneWatch(watchId, watch);
    const afterWatch = watches.get(watchId);
    const after = afterWatch ? JSON.stringify(afterWatch) : "";
    if (before !== after) {
      changed = true;
    }
  }

  if (changed) {
    await persistWatches();
  }
  await syncAlarm();
}

async function listWatches() {
  await ensureHydrated();
  return Array.from(watches.values());
}

async function getWatchForTab(tabId) {
  await ensureHydrated();
  for (const watch of watches.values()) {
    if (watch.tabId === tabId) {
      return watch;
    }
  }
  return null;
}

async function enableWatch(payload) {
  await ensureHydrated();
  const watchId = shared.buildWatchId(payload.tabId, payload.workflowKey);
  const now = Date.now();

  const watch = {
    watchId,
    tabId: payload.tabId,
    workflowKey: payload.workflowKey,
    displayName: payload.displayName || payload.workflowKey,
    notifyOnSuccess: payload.notifyOnSuccess !== false,
    notifyOnFailure: payload.notifyOnFailure !== false,
    createdAt: now,
    lastPhase: "unknown",
    lastCheckedAt: 0,
    missCount: 0
  };

  watches.set(watchId, watch);
  await persistWatches();
  await syncAlarm();
  await pollWatches();

  return watch;
}

async function disableWatch(payload) {
  await ensureHydrated();
  const watch = payload.watchId
    ? watches.get(payload.watchId)
    : await getWatchForTab(payload.tabId);
  if (!watch) {
    return false;
  }
  return removeWatch(watch.watchId);
}

chrome.runtime.onInstalled.addListener(() => {
  hydrateWatches().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  hydrateWatches().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM_NAME) {
    pollWatches().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeWatchesForTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!watchForTabExists(tabId)) {
    return;
  }
  const nextUrl = changeInfo.url || (tab && tab.url) || "";
  if (nextUrl && !shared.isWorkflowRunUrl(nextUrl)) {
    removeWatchesForTab(tabId).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "WATCH_LIST") {
    listWatches()
      .then((items) => sendResponse({ ok: true, watches: items }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "WATCH_GET_FOR_TAB") {
    getWatchForTab(message.tabId)
      .then((watch) => sendResponse({ ok: true, watch }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "WATCH_ENABLE") {
    enableWatch(message)
      .then((watch) => sendResponse({ ok: true, watch }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "WATCH_DISABLE") {
    disableWatch(message)
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});
