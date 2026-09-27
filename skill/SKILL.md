---
name: states
description: Find and fix the UI states AI-built features skip — loading, errors, empty, offline, expired session, double submit. Use when the user types /states, asks "what states does this need", "check the states", "what happens when it fails", or has just built a UI feature and wants it finished. With a feature description and no code, lists the states to build (plan mode). With code (changed files, a folder, or no argument), audits it and fixes gaps with the project's own components (check mode).
---

# /states

AI builds the happy path. This skill finds what happens when things go wrong, ranks it by harm to the user, and fixes it with the project's own components.

`SKILL_DIR` below is the folder this file is in. The scripts are in its parent folder (`$SKILL_DIR/..`). Scratch files go in a **new run folder for every run**: `<scratch>/states-<feature-slug>-<HHMMSS>/` inside the session scratchpad (or `/tmp`). Never reuse a folder; parallel runs overwrite each other. Below, `<scratch>` means that run folder.

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
Pass paths space- or comma-separated. Print its one-line summary. Check that `repo` in scope.json is the project you meant. If it reports no UI files, say so and stop. If `scope.dropped.count` is large, mention that the scope was cut and suggest a narrower path.

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

**Merge.** Read the three files. Merge findings that point at the same `file:line` or the same missing piece (union `where`, keep the clearer repro). If the lenses disagree on consequence, decide with the definitions, not by taking the worst: does the screen state something false → misleading; can the user not finish, or lose work, even after refresh → blocker; otherwise nuisance. A finding from one lens beats an `ok` from another on the same target only if its repro holds when you read the cited line.

**4c. Check the output before showing it.** Each lens file lists its targets; every one must have a `coverage` entry in that lens's output. `not_checked` with a reason like "belongs to the a11y lens" or "not part of this feature" is fine. Send the agent back once only if targets are missing, or left `not_checked` for lack of reading while `reads_used` is under 25. Drop any finding with no `repro`, no `where`, or a `where` whose line doesn't exist. Re-apply the refresh test: if refreshing or retrying recovers it and nothing is lost, it is at most a nuisance. If the JSON is malformed, re-prompt once with the error; after that, judge inline.

**4c-2. Verify (one sceptical agent).** Spawn one general-purpose agent with only `<scratch>/merged.json` and the project root:
```
You are a sceptical verifier. For each finding in <scratch>/merged.json, open every cited file:line and follow the code (helpers, components, status codes) far enough to judge it. Verdict: CONFIRMED (the code clearly behaves as the repro says), PLAUSIBLE (likely, but depends on runtime or server behaviour you can't see), or WRONG (the code already handles it, e.g. a shared component shows a spinner, or the repro can't happen). Check the consequence with the refresh test. Quote the 1–3 lines you relied on. Write <scratch>/verdicts.json as [{id, verdict, consequence_should_be, evidence, note}].
```
Drop WRONG findings. Put `verdict` on each remaining finding in merged.json and adopt the verifier's consequence when its reason is concrete.

**4d. Present** (short, plain language, no raw JSON):

> **Invoices** — 5 states need work (2 blockers, 1 misleading, 2 nuisances). 14 already handled.
>
> 1. **Blocker — Double invoice on slow network.** Create stays clickable while saving. *Try:* throttle network, click Create twice. *Fix:* disable `Button` while pending, show spinner.
> 2. …
>
> Not checked: offline (needs a runtime check).

Then go straight to the report (4e, then 4h), unless the user said they don't want one. It's the default: screenshots of each problem today, the proposed fix, and the score. No code changes.

Fixing is opt-in. End the report message with one line: *"Say **fix** (or **fix 1, 3**) and I'll fix them and add after-screenshots to the report."* If they do, run 4f and 4g, then regenerate the report (4h). Default selection for "fix": all blockers and misleading.

**4e. Capture "today".** If there is no dev server and the user doesn't want one started, skip screenshots; the report still works with drawn mockups. Find the dev server: ask for the URL if one isn't obviously running; start it only if the user agrees (`npm run dev` or the project's script). Confirm it's the right app (fetch the page and check its `<title>`); other projects may be on the same port, and `localhost` vs `127.0.0.1` can reach different servers. If the app needs onboarding or login in every fresh browser, put that in the recipes' top-level `setup`. Write recipes following `$SKILL_DIR/prompts/show.md` into `<scratch>/recipes.json`, then:
```
node $SKILL_DIR/../show-states.mjs <scratch>/recipes.json --base <url> --out <scratch>/shots --label before
```
Look at each screenshot yourself. For each, record in `<scratch>/shots/verify.json` whether it shows the bug: `{ "<id>": { "before_shows_bug": true|false } }`. If one doesn't, fix the recipe once. If it still doesn't:
- For a visible bug (wrong message, missing error, duplicate row, stuck spinner), the screenshot is evidence against the finding. **Drop the finding**, and tell the user it couldn't be reproduced. (On Excalidraw, a "no loading state" finding was disproved this way: the before shot showed a spinner.)
- For something a screenshot can't show (screen-reader names, announcements, server-side races), keep the finding and set `before_shows_bug: false` with a note. If there is no dev server, skip screenshots and say so.

**4f. Fix (only when asked).** For each chosen finding, implement the fix using the named components and the sketch as a starting point. Match the file's conventions (imports, i18n wrapper, class style). Keep diffs minimal. Run the project's type check or lint if one is obvious (`tsc --noEmit`, `npm run lint`) and report the result honestly.

**4g. Capture "after" and verify.** Rerun the same recipes with `--label after`. Look at each yourself and record `after_shows_fix: true|false` (plus a `note` for a fix that works but isn't clean) in `verify.json`. The report only calls a fix "verified" from this file; a fix without it shows as "fixed in code, not verified". The fixed state must show what the finding's fix describes. If it still shows the bug, say so plainly and fix again once. A fix you couldn't confirm on screen is reported as "fixed in code, not verified on screen".

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
