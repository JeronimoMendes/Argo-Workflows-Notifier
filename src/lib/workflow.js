(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ArgoNotifierShared = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
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

  const STATUS_SELECTORS = [
    "[data-testid='workflow-phase']",
    "[data-testid='workflow-status']",
    "[data-test='workflow-phase']",
    "[data-test='workflow-status']",
    "[aria-label='Workflow Status']",
    ".status-badge .status",
    ".status-badge"
  ];

  function cleanText(value) {
    return String(value || "").trim().toLowerCase();
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

  function isTerminalPhase(phase) {
    return TERMINAL_SUCCESS.has(phase) || TERMINAL_FAILURE.has(phase);
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
      return /\/workflows\/[^/]+\/[^/?#]+/.test(parsed.pathname);
    } catch (_error) {
      return false;
    }
  }

  function parseWorkflowFromUrl(url) {
    if (!isWorkflowRunUrl(url)) {
      return null;
    }
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const workflowsIndex = segments.findIndex((segment) => segment === "workflows");
    if (workflowsIndex < 0 || segments.length < workflowsIndex + 3) {
      return null;
    }
    const namespace = segments[workflowsIndex + 1];
    const workflowName = segments[workflowsIndex + 2];
    return {
      namespace,
      workflowName,
      workflowKey: namespace + "/" + workflowName,
      url: parsed.href
    };
  }

  function buildWatchId(tabId, workflowKey) {
    return String(tabId) + ":" + String(workflowKey);
  }

  function getTextFromElement(element) {
    if (!element) {
      return "";
    }
    return String(element.innerText || element.textContent || "");
  }

  function getClassNameFromElement(element) {
    if (!element) {
      return "";
    }
    const className = element.className;
    if (typeof className === "string") {
      return className;
    }
    if (className && typeof className.baseVal === "string") {
      return className.baseVal;
    }
    return "";
  }

  function queryAll(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== "function") {
      return [];
    }
    return Array.from(doc.querySelectorAll(selector));
  }

  function extractPhaseFromNodeClass(element) {
    const classes = getClassNameFromElement(element)
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);

    for (const cls of classes) {
      const phase = normalizePhase(cls);
      if (phase !== "unknown") {
        return phase;
      }
    }
    return "unknown";
  }

  function parseWorkflowDisplayNameFromNodeTitle(nodeTitle) {
    const text = String(nodeTitle || "").trim();
    const match = text.match(/\(([^()]+)\)\s*$/);
    return match && match[1] ? match[1].trim() : "";
  }

  function findPhaseFromTitleNode(titleNode) {
    if (!titleNode || !titleNode.parentElement) {
      return "unknown";
    }

    const parent = titleNode.parentElement;
    const node = parent.querySelector("g.node") || parent.querySelector(".node");
    return extractPhaseFromNodeClass(node);
  }

  function extractPhaseFromArgoGraph(doc, workflowName) {
    const titleNodes = queryAll(doc, ".graph svg title");
    if (titleNodes.length === 0) {
      return "unknown";
    }

    const rootTitleNode = titleNodes.find((titleNode) => {
      const display = parseWorkflowDisplayNameFromNodeTitle(getTextFromElement(titleNode));
      return Boolean(workflowName && display && display === workflowName);
    });
    if (rootTitleNode) {
      const rootPhase = findPhaseFromTitleNode(rootTitleNode);
      if (rootPhase !== "unknown") {
        return rootPhase;
      }
    }

    for (const titleNode of titleNodes) {
      const titleText = getTextFromElement(titleNode);
      if (/^artifact:/i.test(titleText)) {
        continue;
      }
      const phase = findPhaseFromTitleNode(titleNode);
      if (phase !== "unknown") {
        return phase;
      }
    }

    return "unknown";
  }

  function extractStatusFromBodyText(doc) {
    const bodyText = getTextFromElement(doc && doc.body);
    if (!bodyText) {
      return "unknown";
    }

    const statusLineMatch = bodyText.match(
      /(?:^|\n)\s*status\s*[:\-]\s*([A-Za-z_ ]{3,32})(?:\n|$)/i
    );
    if (statusLineMatch && statusLineMatch[1]) {
      return normalizePhase(statusLineMatch[1]);
    }

    return "unknown";
  }

  function extractPhaseFromDocument(doc, options) {
    if (!doc) {
      return "unknown";
    }
    const workflowName = options && options.workflowName ? options.workflowName : "";

    const graphPhase = extractPhaseFromArgoGraph(doc, workflowName);
    if (graphPhase !== "unknown") {
      return graphPhase;
    }

    for (const selector of STATUS_SELECTORS) {
      const nodes = queryAll(doc, selector);
      for (const node of nodes) {
        const phase = normalizePhase(getTextFromElement(node));
        if (phase !== "unknown") {
          return phase;
        }
      }
    }

    return extractStatusFromBodyText(doc);
  }

  return {
    STATUS_SELECTORS,
    buildWatchId,
    evaluateWatchObservation,
    extractPhaseFromArgoGraph,
    extractPhaseFromDocument,
    getOutcomeForPhase,
    isTerminalPhase,
    isWorkflowRunUrl,
    normalizePhase,
    parseWorkflowFromUrl
  };
});
