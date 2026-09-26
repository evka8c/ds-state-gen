# /states show: capture the state, before and after

You turn each finding's `repro` into a **recipe** that `show-states.mjs` can play in a real browser, so the user sees the broken state and then the fixed one. You don't judge anything here; the finding is already decided.

## Input
- The merged findings JSON (only the findings the user chose to fix).
- The app's base URL (e.g. `http://localhost:5173`) — the dev server must already be running.
- The project's route files, only if you need a URL.

## Write one recipe per finding

```json
{
  "id": "F2",
  "title": "Failed load shows 'No invoices yet'",
  "url": "/invoices",
  "network": [{ "match": "/api/invoices", "method": "GET", "respond": { "status": 500 } }],
  "steps": [
    { "wait": "text=No invoices yet", "timeout": 5000 }
  ],
  "capture": { "selector": "main" },
  "expect_after": "An error message with a Try again button, not the empty state"
}
```

### Network conditions (`network[]`, applied before the page loads)
- `respond: { status, body? }` — fake a server response (500, 403, 401, 404).
- `abort: true` — the request fails as a network error.
- `delay: 3000` — slow response (pair with a step that acts during the wait).
- `once: true` — only the first matching request is affected (e.g. the first save fails, the retry works).
- Top-level `"offline": true` goes offline after the page loads.

### Steps (`steps[]`, played in order)
`{ "click": "<selector>" }`, `{ "dblclick": "<selector>" }`, `{ "fill": "<selector>", "value": "..." }`, `{ "select": "<select selector>", "value": "overdue" }`, `{ "press": "Tab" }`, `{ "wait": "<selector>" | ms }`, `{ "goto": "/path" }`, `{ "offline": true|false }`, `{ "upload": "<file input selector>", "file": { "name": "big.zip", "size": 26214400 } }` (picks a generated file of that size), `{ "shot": "label" }` (an extra screenshot mid-flow).

Selectors: prefer text and roles (`text=Create invoice`, `role=button[name="Delete"]`, `[aria-label="..."]`), then stable attributes. Read the component to get real copy. Never invent copy.

### Capture
`{ "selector": "..." }` for the region that shows the state, or `"page"`. Screenshots are shown about 600px wide, so waste no space: capture the region, or give the recipe a smaller `"viewport": { "width": 1000, "height": 560 }` when the state needs page-level context such as a toast (toasts sit in the bottom-right corner, outside any region), or use `{ "clip": { "x", "y", "width", "height" } }`. For a double-submit bug, capture the list after the double click (two identical rows). For a keyboard bug, capture after pressing Tab to show where focus lands (`"focus": true` outlines the focused element).

### What can't be shown
Some findings can't be reproduced by a browser recipe (a 1-hour token expiry, a server race). Give them `"skip": "reason"` and suggest how to force it (`respond: { status: 403 }` on the request the expiry would fail usually works — prefer that over skipping).

## Output
Only JSON: `{ "base_url": "...", "recipes": [ ... ] }`.
