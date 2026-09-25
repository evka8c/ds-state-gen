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

**4b. Judge (one subagent):** spawn one general-purpose agent so the file reads don't flood this conversation:
```
Read your instructions from $SKILL_DIR/prompts/check.md and follow them exactly.
Output schema: $SKILL_DIR/schema/findings.schema.json
Scope JSON: <scratch>/scope.json
Project root: <path>
App context: <the context block, or "none — use defaults">
Return only the JSON.
```
If you already read most of the scoped files in this conversation, you may judge inline instead, following the same prompt and budget.

**4c. Check the output before showing it.** Every top-10 action, sibling screen, guard and a11y hint in the scope JSON must have a `coverage` entry; if any are missing, or marked `not_checked` with `reads_used` under 25, send the agent back once with the list of missing targets. Drop any finding with no `repro`, no `where`, or a `where` whose line doesn't exist. Re-apply the refresh test: if refreshing or retrying recovers it and nothing is lost, it is at most a nuisance. If the JSON is malformed, re-prompt once with the error; after that, judge inline.

**4d. Present** (short, plain language, no raw JSON):

> **Invoices** — 5 states need work (2 blockers, 1 misleading, 2 nuisances). 14 already handled.
>
> 1. **Blocker — Double invoice on slow network.** Create stays clickable while saving. *Try:* throttle network, click Create twice. *Fix:* disable `Button` while pending, show spinner.
> 2. …
>
> Not checked: offline (needs a runtime check).

Then ask which to fix (default: all blockers and misleading).

**4e. Fix.** For each chosen finding, implement the fix in the project using the named components and the sketch as a starting point. Match the file's conventions (imports, i18n wrapper, class style). Keep diffs minimal. After editing, run the project's type check or lint if one is obvious (`tsc --noEmit`, `npm run lint`) and report the result honestly.

## Rules

- Never scan the whole repo in check mode. Scope is the diff or the paths given.
- Don't list handled states one by one; give the count.
- Don't write the old HTML report unless asked. If asked for a shareable report, use `generate-report.mjs` as described in the repo's CLAUDE.md.
- Say what wasn't checked. Never present "not found" as "fine".
