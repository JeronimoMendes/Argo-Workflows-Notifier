/* global chrome */
"use strict";

const PHASE_ALIASES = new Map([
  ["succeeded", "succeeded"],
  ["success", "succeeded"],
  ["completed", "succeeded"],
  ["failed", "failed"],
  ["failure", "failed"],
  ["error", "error"],
  ["errored", "error"],
  ["pending", "pending"],
  ["running", "running"],
  ["inprogress", "running"],
  ["in_progress", "running"],
  ["unknown", "unknown"]
]);

const TERMINAL_SUCCESS = new Set(["succeeded"]);
const TERMINAL_FAILURE = new Set(["failed", "error"]);

function cleanText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizePhase(value) {
  const raw = cleanText(value);
  if (!raw) {
    return "unknown";
  }
  const compact = raw.replace(/\s+/g, "");
  if (PHASE_ALIASES.has(compact)) {
    return PHASE_ALIASES.get(compact);
  }
  if (/succeed/.test(raw)) {
    return "succeeded";
  }
  if (/fail/.test(raw)) {
    return "failed";
  }
  if (/error/.test(raw)) {
    return "error";
  }
  if (/running/.test(raw)) {
    return "running";
  }
  if (/pending|queued/.test(raw)) {
    return "pending";
  }
  return "unknown";
}

function getOutcomeForPhase(phase) {
  if (TERMINAL_SUCCESS.has(phase)) {
    return "success";
  }
  if (TERMINAL_FAILURE.has(phase)) {
    return "failure";
  }
  return null;
}

function evaluateWatchObservation(watch, observedPhase, observedAt) {
  const phase = normalizePhase(observedPhase);
  const nextWatch = {
    ...watch,
    lastPhase: phase,
    lastCheckedAt: observedAt || Date.now()
  };
  const outcome = getOutcomeForPhase(phase);
  if (!outcome) {
    return { nextWatch, isTerminal: false, shouldNotify: false, outcome: null };
  }
  const shouldNotify =
    (outcome === "success" && Boolean(watch.notifyOnSuccess)) ||
    (outcome === "failure" && Boolean(watch.notifyOnFailure));

  return { nextWatch, isTerminal: true, shouldNotify, outcome };
}

function isWorkflowRunUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return /^\/workflows\/[^/]+\/[^/?#]+/.test(parsed.pathname);
  } catch (_error) {
    return false;
  }
}

function buildWatchId(tabId, workflowKey) {
  return String(tabId) + ":" + String(workflowKey);
}

const ALARM_NAME = "argo-workflow-notifier-poll";
const ALARM_PERIOD_MINUTES = 0.5;

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
      if (!tab) {
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

async function playNotificationSound() {
  const { soundMuted = false, soundVolume = 1 } = await chrome.storage.local.get([
    "soundMuted",
    "soundVolume"
  ]);
  if (soundMuted) {
    return;
  }

  const offscreenUrl = chrome.runtime.getURL("src/offscreen.html");
  const existingContexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play notification sound"
    });
  }
  chrome.runtime.sendMessage({ type: "play-notification-sound", volume: soundVolume });
}

async function createNotification(title, message) {
  const iconUrl = chrome.runtime.getURL("icons/icon128.png");
  const notificationId = "argo-watch-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);

  return new Promise((resolve, reject) => {
    chrome.notifications.create(
      notificationId,
      {
        type: "basic",
        requireInteraction: true,
        iconUrl,
        title,
        message
      },
      (createdId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(createdId || notificationId);
      }
    );
  });
}

async function sendWorkflowNotification(watch, outcome) {
  const title = outcome === "success" ? "Argo workflow succeeded 🟢" : "Argo workflow failed 🔴";
  const message =
    outcome === "success"
      ? watch.displayName + " finished successfully."
      : watch.displayName + " finished with errors.";
  await createNotification(title, message);
  await playNotificationSound();
}

async function applyObservationToWatch(watchId, watch, phase, observedAt) {
  const evaluation = evaluateWatchObservation(watch, phase, observedAt || Date.now());
  const nextWatch = { ...evaluation.nextWatch, missCount: 0 };

  if (evaluation.isTerminal) {
    const alreadyNotified =
      Boolean(watch.terminalNotified) && watch.lastNotifiedOutcome === evaluation.outcome;

    if (evaluation.shouldNotify) {
      if (!alreadyNotified) {
        try {
          await sendWorkflowNotification(nextWatch, evaluation.outcome);
        } catch (_error) {
          // Keep watch state deterministic even if OS/browser suppresses notifications.
        }
      }
    }

    watches.set(watchId, {
      ...nextWatch,
      terminalNotified: true,
      lastNotifiedOutcome: evaluation.outcome
    });
    return true;
  }

  watches.set(watchId, {
    ...nextWatch,
    terminalNotified: false,
    lastNotifiedOutcome: null
  });
  return true;
}

async function checkOneWatch(watchId, watch) {
  try {
    const tab = await chrome.tabs.get(watch.tabId);
    if (!tab) {
      watches.delete(watchId);
      return true;
    }
    if (!isWorkflowRunUrl(tab.url || "")) {
      watches.set(watchId, {
        ...watch,
        lastCheckedAt: Date.now(),
        missCount: (watch.missCount || 0) + 1
      });
      return true;
    }

    const response = await chrome.tabs.sendMessage(watch.tabId, { type: "GET_WORKFLOW_STATUS" });
    if (!response || !response.workflowKey || !response.phase) {
      watches.set(watchId, {
        ...watch,
        lastCheckedAt: Date.now(),
        missCount: (watch.missCount || 0) + 1
      });
      return true;
    }

    if (response.workflowKey !== watch.workflowKey) {
      watches.set(watchId, {
        ...watch,
        lastCheckedAt: Date.now(),
        missCount: (watch.missCount || 0) + 1
      });
      return true;
    }

    return applyObservationToWatch(
      watchId,
      watch,
      response.phase,
      response.observedAt || Date.now()
    );
  } catch (_error) {
    watches.set(watchId, {
      ...watch,
      lastCheckedAt: Date.now(),
      missCount: (watch.missCount || 0) + 1
    });
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
    const didChange = await checkOneWatch(watchId, watch);
    if (didChange) {
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

function findWatchByTabAndWorkflowKey(tabId, workflowKey) {
  for (const watch of watches.values()) {
    if (watch.tabId === tabId && watch.workflowKey === workflowKey) {
      return watch;
    }
  }
  return null;
}

async function enableWatch(payload) {
  await ensureHydrated();
  const watchId = buildWatchId(payload.tabId, payload.workflowKey);
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
    missCount: 0,
    terminalNotified: false,
    lastNotifiedOutcome: null
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

function normalizeDisplayName(value, fallback) {
  const text = String(value || "").trim();
  if (text) {
    return text;
  }
  return String(fallback || "").trim() || "Unnamed workflow";
}

async function renameWatch(payload) {
  await ensureHydrated();
  if (!payload || !payload.watchId) {
    return null;
  }
  const watch = watches.get(payload.watchId);
  if (!watch) {
    return null;
  }

  const nextWatch = {
    ...watch,
    displayName: normalizeDisplayName(payload.displayName, watch.workflowKey)
  };
  watches.set(nextWatch.watchId, nextWatch);
  await persistWatches();
  return nextWatch;
}

async function applyPushedStatus(message, sender) {
  await ensureHydrated();

  const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
  if (typeof tabId !== "number") {
    return { ok: true, ignored: true, reason: "missing_tab" };
  }

  const workflowKey = String(message.workflowKey || "");
  if (!workflowKey) {
    return { ok: true, ignored: true, reason: "missing_workflow_key" };
  }
  const phase = String(message.phase || "");
  if (!phase) {
    return { ok: true, ignored: true, reason: "missing_phase" };
  }

  const watch = findWatchByTabAndWorkflowKey(tabId, workflowKey);
  if (!watch) {
    return { ok: true, ignored: true, reason: "watch_not_found" };
  }

  const changed = await applyObservationToWatch(
    watch.watchId,
    watch,
    phase,
    message.observedAt || Date.now()
  );
  if (changed) {
    await persistWatches();
    await syncAlarm();
  }

  return { ok: true, changed };
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
  void changeInfo;
  void tab;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "WORKFLOW_STATUS_PUSH") {
    applyPushedStatus(message, _sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
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

  if (message.type === "WATCH_RENAME") {
    renameWatch(message)
      .then((watch) => sendResponse({ ok: true, watch }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "DEV_FIRE_NOTIFICATION") {
    const outcome = message.outcome === "failure" ? "failure" : "success";
    const fakeWatch = { displayName: message.displayName || "test-workflow-abc123" };
    sendWorkflowNotification(fakeWatch, outcome)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});
