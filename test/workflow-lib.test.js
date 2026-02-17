const test = require("node:test");
const assert = require("node:assert/strict");

const shared = require("../src/lib/workflow.js");

test("normalizePhase maps aliases and loose strings", () => {
  assert.equal(shared.normalizePhase("Succeeded"), "succeeded");
  assert.equal(shared.normalizePhase("ERROR"), "error");
  assert.equal(shared.normalizePhase("In Progress"), "running");
  assert.equal(shared.normalizePhase("Queued"), "pending");
  assert.equal(shared.normalizePhase("something-else"), "unknown");
});

test("isWorkflowRunUrl and parseWorkflowFromUrl handle argo run URL", () => {
  const url = "https://argo.example.com/workflows/prod/my-run-abc123?tab=workflow";
  assert.equal(shared.isWorkflowRunUrl(url), true);

  const parsed = shared.parseWorkflowFromUrl(url);
  assert.deepEqual(parsed, {
    namespace: "prod",
    workflowName: "my-run-abc123",
    workflowKey: "prod/my-run-abc123",
    url
  });
});

test("evaluateWatchObservation marks terminal outcomes", () => {
  const watch = {
    watchId: "1:prod/my-run-abc123",
    tabId: 1,
    workflowKey: "prod/my-run-abc123",
    displayName: "my-run-abc123",
    notifyOnSuccess: true,
    notifyOnFailure: true
  };

  const successEval = shared.evaluateWatchObservation(watch, "Succeeded", 100);
  assert.equal(successEval.isTerminal, true);
  assert.equal(successEval.shouldNotify, true);
  assert.equal(successEval.outcome, "success");
  assert.equal(successEval.nextWatch.lastPhase, "succeeded");
  assert.equal(successEval.nextWatch.lastCheckedAt, 100);

  const failureEval = shared.evaluateWatchObservation(watch, "Failed", 200);
  assert.equal(failureEval.isTerminal, true);
  assert.equal(failureEval.shouldNotify, true);
  assert.equal(failureEval.outcome, "failure");
  assert.equal(failureEval.nextWatch.lastPhase, "failed");
  assert.equal(failureEval.nextWatch.lastCheckedAt, 200);
});

test("extractPhaseFromDocument prefers status selectors then body status line", () => {
  const selectorNodes = {
    "[data-testid='workflow-phase']": [{ textContent: "Running" }]
  };
  const fakeDoc = {
    querySelectorAll(selector) {
      return selectorNodes[selector] || [];
    },
    body: {
      innerText: "Status: Failed"
    }
  };
  assert.equal(shared.extractPhaseFromDocument(fakeDoc), "running");

  const fakeDocBodyOnly = {
    querySelectorAll() {
      return [];
    },
    body: {
      innerText: "Some panel\nStatus: Succeeded\nOther info"
    }
  };
  assert.equal(shared.extractPhaseFromDocument(fakeDocBodyOnly), "succeeded");
});

test("extractPhaseFromDocument reads workflow phase from argo graph root node", () => {
  const workflowName = "ingestion--galp--ictio-alcazar-bq774";

  const makeTitleNode = (titleText, className) => ({
    textContent: titleText,
    parentElement: {
      querySelector(selector) {
        if (selector === "g.node" || selector === ".node") {
          return { className: { baseVal: className } };
        }
        return null;
      }
    }
  });

  const fakeDoc = {
    querySelectorAll(selector) {
      if (selector === ".graph svg title") {
        return [
          makeTitleNode(workflowName + "-123456789 (parametrize)", "node Succeeded "),
          makeTitleNode(workflowName + " (" + workflowName + ")", "node Running "),
          makeTitleNode("artifact:azure:.../conventions.tgz", "node Artifact ")
        ];
      }
      return [];
    },
    body: {
      innerText: ""
    }
  };

  assert.equal(shared.extractPhaseFromDocument(fakeDoc, { workflowName }), "running");
});

test("extractPhaseFromDocument prefers graph root phase over generic status badges", () => {
  const workflowName = "train-v0.0.1-8sz46";

  const makeTitleNode = (titleText, className) => ({
    textContent: titleText,
    parentElement: {
      querySelector(selector) {
        if (selector === "g.node" || selector === ".node") {
          return { className: { baseVal: className } };
        }
        return null;
      }
    }
  });

  const fakeDoc = {
    querySelectorAll(selector) {
      if (selector === ".graph svg title") {
        return [makeTitleNode(workflowName + " (" + workflowName + ")", "node Succeeded ")];
      }
      if (selector === ".status-badge .status") {
        return [{ textContent: "Running" }];
      }
      return [];
    },
    body: { innerText: "" }
  };

  assert.equal(shared.extractPhaseFromDocument(fakeDoc, { workflowName }), "succeeded");
});
