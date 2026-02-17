# Argo Workflow Notifier (Chromium Extension)

Browser extension to watch Argo workflow run pages and send a native browser notification when a watched run reaches terminal state (`Succeeded`, `Failed`, or `Error`).

## Features

- Toggle notifications from the extension popup while on an Argo workflow run page.
- Track multiple workflows at the same time (across open tabs).
- Polls workflow status every 30s while watched tabs stay open.
- Sends one notification per watched workflow, then auto-stops the watch.
- No extension-level Argo authentication config; uses the active open tab session.

## Project structure

- `manifest.json`: Extension manifest (MV3).
- `src/background.js`: Watch registry, polling, notifications, tab lifecycle cleanup.
- `src/content.js`: Reads current workflow context/status from the page DOM.
- `src/lib/workflow.js`: Shared parsing/normalization logic.
- `src/popup.*`: Popup UI for toggling and listing active watches.
- `test/workflow-lib.test.js`: Unit tests for core shared logic.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository root.

## Usage

1. Open your Argo workflow run page (`/workflows/<namespace>/<workflowName>`).
2. Open the extension popup.
3. Click **Enable notifications**.
4. Keep the tab open.
5. You get one browser notification when the run succeeds or fails.

## Development

Run tests:

```bash
npm test
```

Run lint:

```bash
npm run lint
```

Format code:

```bash
npm run format
```
