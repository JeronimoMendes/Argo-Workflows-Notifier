/* global ArgoNotifierShared, chrome */
"use strict";

const shared = ArgoNotifierShared;

function getWorkflowDisplayName(parsed) {
  const titleElement =
    document.querySelector("[data-testid='page-title']") ||
    document.querySelector("h1") ||
    document.querySelector("[class*='workflow'][class*='title']");
  const titleText = titleElement ? String(titleElement.textContent || "").trim() : "";
  if (titleText) {
    return titleText;
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

  const phase = shared.extractPhaseFromDocument(document);
  return {
    ok: true,
    workflowKey: parsed.workflowKey,
    phase,
    observedAt: Date.now()
  };
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
