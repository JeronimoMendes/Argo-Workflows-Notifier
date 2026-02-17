/* global ArgoNotifierShared, chrome */
"use strict";

const shared = ArgoNotifierShared;

function getWorkflowDisplayName(parsed) {
  const titleElement =
    document.querySelector(".top-bar__breadcrumbs-last-item") ||
    document.querySelector("[data-testid='page-title']") ||
    document.querySelector("h1") ||
    document.querySelector("[class*='workflow'][class*='title']");
  const titleText = titleElement ? String(titleElement.textContent || "").trim() : "";
  if (titleText) {
    return titleText;
  }
  const pageTitle = String(document.title || "").trim();
  if (pageTitle) {
    const split = pageTitle.split(" / ");
    if (split[0] && split[0].trim()) {
      return split[0].trim();
    }
  }
  return parsed.workflowName;
}

function getContextPayload() {
  const parsed = shared.parseWorkflowFromUrl(window.location.href);
  if (!parsed) {
    return { ok: false, reason: "not_workflow_run_page" };
  }
  return {
    ok: true,
    namespace: parsed.namespace,
    workflowName: parsed.workflowName,
    workflowKey: parsed.workflowKey,
    displayName: getWorkflowDisplayName(parsed),
    url: parsed.url
  };
}

function getStatusPayload() {
  const parsed = shared.parseWorkflowFromUrl(window.location.href);
  if (!parsed) {
    return { ok: false, reason: "not_workflow_run_page" };
  }

  const phase = shared.extractPhaseFromDocument(document, {
    workflowName: parsed.workflowName
  });
  return {
    ok: true,
    workflowKey: parsed.workflowKey,
    phase,
    observedAt: Date.now()
  };
}

let lastPushedWorkflowKey = "";
let lastPushedPhase = "";
let pendingPushTimer = 0;

function queueStatusPush(delayMs) {
  if (pendingPushTimer) {
    clearTimeout(pendingPushTimer);
  }
  pendingPushTimer = window.setTimeout(() => {
    pendingPushTimer = 0;
    pushStatusToBackground(false);
  }, delayMs);
}

function pushStatusToBackground(force) {
  const status = getStatusPayload();
  if (!status.ok) {
    return;
  }
  if (!force && status.workflowKey === lastPushedWorkflowKey && status.phase === lastPushedPhase) {
    return;
  }
  lastPushedWorkflowKey = status.workflowKey;
  lastPushedPhase = status.phase;

  chrome.runtime.sendMessage(
    {
      type: "WORKFLOW_STATUS_PUSH",
      workflowKey: status.workflowKey,
      phase: status.phase,
      observedAt: status.observedAt
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function initStatusPushLoop() {
  const parsed = shared.parseWorkflowFromUrl(window.location.href);
  if (!parsed) {
    return;
  }

  const observer = new MutationObserver(() => {
    queueStatusPush(500);
  });
  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      queueStatusPush(150);
    }
  });
  window.addEventListener("focus", () => queueStatusPush(150));
  window.setInterval(() => pushStatusToBackground(false), 5000);

  pushStatusToBackground(true);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "GET_WORKFLOW_CONTEXT") {
    sendResponse(getContextPayload());
    return false;
  }

  if (message.type === "GET_WORKFLOW_STATUS") {
    sendResponse(getStatusPayload());
    return false;
  }

  return false;
});

initStatusPushLoop();
