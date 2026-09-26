---
name: states
description: Find and fix the UI states AI-built features skip — loading, errors, empty, offline, expired session, double submit. Use when the user types /states, asks "what states does this need", "check the states", "what happens when it fails", or has just built a UI feature and wants it finished. With a feature description and no code, lists the states to build (plan mode). With code (changed files, a folder, or no argument), audits it and fixes gaps with the project's own components (check mode).
---

# /states

AI builds the happy path. This skill finds what happens when things go wrong, ranks it by harm to the user, and fixes it with the project's own components.

`SKILL_DIR` below is the folder this file is in. The scripts are in its parent folder (`$SKILL_DIR/..`). Scratch files go in the session scratchpad (or `/tmp` if none).

## 1. Pick the mode

- `/states "invoice table with filters and bulk delete"` — a description, no code to look at → **plan**.
- `/states` — no argument → **check** the files changed on this branch (plus uncommitted).
- `/states src/app/invoices` or file paths → **check** those.
- If the request is ambiguous (e.g. a description of something that already exists), ask once.

## 2. Context (both modes)

Look for `.states.yml` in the project root. It holds:
```yaml
context:
  unsaved_work: yes | partly | no        # can people lose work they haven't saved?
  poor_connectivity_is_normal: yes | no  # field work, travel, in flight
  stakes: [legal, payments, accessibility]  # optional
```
If it's missing, don't ask up front. Run with defaults, and at the end ask the two questions once and offer to save the answers there (they change severity next time).

## 3. Plan mode

```
node $SKILL_DIR/../states-scan.mjs plan "<description>" [--repo <project root, if there is one>] --out <scratch>/plan.json
```
Then follow `$SKILL_DIR/prompts/plan.md` yourself (inline, no subagent — it reads no code). Output matches `$SKILL_DIR/schema/plan.schema.json`, but show it as text:

- **Must build** — one line each: state, what the user sees, component.
- **Later** — one line each.
- The `build_prompt` block in a fenced code block, then: "Paste this into your build prompt, or say *build it* and I'll build the feature with these states."

## 4. Check mode

**4a. Scan (script, ~1s, no tokens):**
```
node $SKILL_DIR/../states-scan.mjs check <project root> [--paths <paths>] --out <scratch>/scope.json
```
Print its one-line summary. If it reports no UI files, say so and stop. If `scope.dropped.count` is large, mention that the scope was cut and suggest a narrower path.

**4b. Judge (three reviewers in parallel).** Always run all three; one pass misses too much. Spawn three general-purpose agents in one message, each with:
```
Read $SKILL_DIR/prompts/check.md, then your lens $SKILL_DIR/prompts/lens-<name>.md, and follow them exactly. The lens replaces section 1 of check.md.
Output schema: $SKILL_DIR/schema/findings.schema.json
Scope JSON: <scratch>/scope.json
Project root: <path>
App context: <the context block, or "none — use defaults">
Write the JSON to <scratch>/findings-<name>.json and reply with a 3-line summary.
```
Lenses: `actions` (every action and guard: double submit, failure in every mode, input on 401, offline/cancel, rollback, guard holes), `screens` (who lands on each screen, truthful copy, config dead ends, v1/v2 parity, taxonomy states), `a11y` (keyboard path, names, announcements, dialogs, time limits).

**Merge.** Read the three files. Merge findings that point at the same `file:line` or the same missing piece (keep the worst consequence, union `where`, keep the clearer repro). A finding from one lens beats an `ok` from another on the same target only if its repro holds when you read the cited line.

**4c. Check the output before showing it.** Each lens file lists its targets; every one must have a `coverage` entry in that lens's output. If any are missing, or `not_checked` with `reads_used` under 25, send that agent back once with the list. Drop any finding with no `repro`, no `where`, or a `where` whose line doesn't exist. Re-apply the refresh test: if refreshing or retrying recovers it and nothing is lost, it is at most a nuisance. If the JSON is malformed, re-prompt once with the error; after that, judge inline.

**4d. Present** (short, plain language, no raw JSON):

> **Invoices** — 5 states need work (2 blockers, 1 misleading, 2 nuisances). 14 already handled.
>
> 1. **Blocker — Double invoice on slow network.** Create stays clickable while saving. *Try:* throttle network, click Create twice. *Fix:* disable `Button` while pending, show spinner.
> 2. …
>
> Not checked: offline (needs a runtime check).

Then ask one question (AskUserQuestion) with these options:
- **Fix and show report (recommended)** — fix the chosen findings, then build the visual report with before/after screenshots.
- **Fix only** — fix, then summarise what changed.
- **Report only** — build the report with "today" screenshots and the proposed fix, change no code.
- **Not now.**
Also let them narrow which findings (default: all blockers and misleading).

**4e. Capture "today" (if a report was chosen).** Find the dev server: ask for the URL if one isn't obviously running; start it only if the user agrees (`npm run dev` or the project's script). Write recipes following `$SKILL_DIR/prompts/show.md` into `<scratch>/recipes.json`, then:
```
node $SKILL_DIR/../show-states.mjs <scratch>/recipes.json --base <url> --out <scratch>/shots --label before
```
Look at each screenshot. If one doesn't show the bug, fix the recipe once; if it still doesn't, drop that screenshot (the report falls back to a drawn mockup). If there is no dev server, skip screenshots and say so.

**4f. Fix.** For each chosen finding, implement the fix using the named components and the sketch as a starting point. Match the file's conventions (imports, i18n wrapper, class style). Keep diffs minimal. Run the project's type check or lint if one is obvious (`tsc --noEmit`, `npm run lint`) and report the result honestly.

**4g. Capture "after" and verify.** Rerun the same recipes with `--label after`. Look at each: the fixed state must now show what the finding's fix describes. If it still shows the bug, say so plainly and fix again once. A fix you couldn't confirm on screen is reported as "fixed in code, not verified on screen".

**4h. Report.**
```
node $SKILL_DIR/../generate-report.mjs --findings <scratch>/merged.json --shots <scratch>/shots \
  --meta <scratch>/meta.json --out reports/<slug>.html
```
`meta.json`: `{ feature, description, project_path, context, summary }`, where `summary` is 2–3 plain sentences: the worst thing a user hits, the counts, and what was fixed. Open the report, check the frames at a glance, and give the path.

## Rules

- Never scan the whole repo in check mode. Scope is the diff or the paths given.
- Don't list handled states one by one; give the count.
- Always offer the HTML report (4d), but only build it when asked (4e). Use `generate-report.mjs`, never the Report Builder agent.
- Say what wasn't checked. Never present "not found" as "fine".
