# Worklog

Running notes on what changed and why, so any session opened in this repo can pick up where the last one stopped.

## 2026-09-25: Visual report v2, consequence-based severity, first public test

### Why

The tool had one commit (May 2026) and had only ever run on FlyTabs. We wanted to know two things:

1. **Is it useful on a codebase nobody here wrote?**
2. **How does it compare with [roast-my-design-system](https://github.com/gregkozakiewicz/roast-my-design-system)**, which scores token and component hygiene and has 15,000+ npm downloads?

Roast measures colours, spacing, radii, duplicated components and inline styles. It explicitly does **not** measure UI states, motion or accessibility. States are the gap this tool fills.

### Test run: Documenso recipient signing page

- Target: [documenso/documenso](https://github.com/documenso/documenso) (open-source DocuSign alternative; Remix + shadcn), the `/sign/:token` page. Shallow clone at commit `fix: add date-fns to packages/ui (#3388)`, 2026-09-24.
- Ran the full pipeline: Scanner, Enumerator and Auditor as agents, then the report script.
- Cost: about 15 minutes of wall clock and about 525K subagent tokens (Scanner 136K, Enumerator 241K, Auditor 148K). Roast scans the same repo in 2 seconds.
- Result: 150 states enumerated (113 discovered in the feature code, 26 from the taxonomy, 11 screen-level).
- Every finding was checked by hand against the source before being trusted. All were true:
  - no offline detection anywhere
  - PDF load error says "try again" with nothing to click
  - link expiry only checked on page load
  - `/complete`, `/expired`, `/rejected` show "Sign up" to people who already have accounts
  - 2FA Verify stays enabled after the code expires, then says "invalid code"
  - field overlay buttons have no accessible name; the draw canvas has no keyboard path
  - the signature pad throws when a sender disables every signature method
- All run inputs are saved in `examples/documenso-signing/data/`, so the example report can be regenerated without re-running the agents.

### What was wrong with the old report

- **The score was meaningless.** 94.6% covered, because every state the Enumerator discovered in the code counted as covered. It measured how much code was read.
- **Nothing visual.** A text matrix, while roast shows swatches, type at real size and a share card.
- **Empty Implementation column** (the Auditor never emits that field).
- Evidence column overflowed the table; the script read stdin whenever stdin wasn't a TTY, so passing file paths from some shells failed; a leftover FlyTabs `--ft-` token prefix.

### What changed

**Report (`generate-report.mjs`, `templates/report.css`)**
- Score out of 100 that starts at 100 and deducts for missing and half-built states. Only states the page *needs* count (taxonomy, screen-level, and anything the Auditor found not covered). Code-discovered states move to a collapsed "What already exists" section.
- Hero: score, "N fixes lift it to X", counts, and a plain-language summary (from `meta.summary`, labelled as written by AI).
- **Where to start:** top 3 fixes, each with a *Today* and *Proposed* mockup and a "Copy the fix prompt" button.
- **Every state this page needs:** a grid of thumbnails drawn with the project's own tokens (colours, radius, font are read from the Scanner inventory). Dashed red = no design, yellow = half-built, green = designed.
- Evidence table kept, wraps properly, shows "Build from" and "Notes".
- Share card: `{report}-card.svg`, 1200x630, light.
- Mockup kit: `mk-*` classes in `report.css`. The orchestrator writes Today/Proposed HTML with them; the script injects the project's tokens.
- CLI: `node generate-report.mjs auditor.json inventory.json --enumerator e.json --mockups m.json --meta meta.json --out reports/x.html`. Status JSON goes to stderr.

**Severity by consequence, not likelihood** (Eva's call after seeing v2)

Offline came out as the #1 fix on Documenso. That is wrong: every web app goes offline, and on a page that saves each field as you go, the user just refreshes. The Enumerator had marked it critical because phone users *will hit it*, which is likelihood, not harm.

New rule, applied by the Auditor (`agents/auditor.md` section 3b), with one test first: **does refreshing or retrying fix it?**

| Level | Meaning | Gap / half-built cost |
|---|---|---|
| Blocker | Can't finish, and refresh or retry doesn't help | 20 / 12 |
| Misleading | The screen says something false, so the user acts wrongly | 10 / 6 |
| Nuisance | Refresh or retry recovers it, nothing lost | 4 / 2 |

App context moves states between levels. Two setup questions now live in `config/project.example.yml` under `context`:
- `unsaved_work`: can users lose work they haven't saved? If yes, network loss and session expiry become blockers.
- `poor_connectivity_is_normal`: field work, travel, in flight? If yes, offline states are at least misleading.
- `stakes`: legal, payment, medical or accessibility obligations make access failures blockers.

The Enumerator's `priority` now means likelihood only (`agents/enumerator.md`). The report groups thumbnails worst first: blockers, misleading, nuisances, optional, designed.

### Documenso, reclassified by consequence

An agent re-read the code for each finding and checked whether refreshing or retrying actually recovers it. Every claim below was verified by hand before merging. Inputs and its output are in `examples/documenso-signing/data/` (`reclassify.json` holds the raw calls).

- **App context:** unsaved work is *partly*. Each field saves to the server as it's inserted, but a signature drawn in the pad and text in an open dialog are lost on refresh.
- **Score: 22/100. Three fixes lift it to 74.** (Under the old likelihood weights it was 45, with Offline on top.)

| Consequence | States |
|---|---|
| Blocker | **Keyboard navigation** (gap): new envelopes are V2 (`create-envelope.ts` sets `internalVersion: 2`) and their fields are Konva canvas shapes that only listen to `pointerdown` (`envelope-signer-page-renderer.tsx`), so a keyboard-only recipient can't insert any field. **Screen reader** (gap): V2 fields expose nothing to assistive tech; V1 field buttons have no name. **Signature methods restricted** (was covered, now half-built): the UI prevents disabling all three methods, but the public API (`api/v1/schema.ts`) accepts it, and then the signature pad throws and every recipient lands on the 500 page. |
| Misleading | Status pages tell existing account holders to "Sign up". V2 text fields accept over-long input and then show a generic error and clear the text. An expired 2FA code is reported as "Invalid verification code". |
| Nuisance | Offline (was the #1 gap), PDF load error without a retry button, slow connection, link expiring mid-session. |

The keyboard and screen reader findings are the headline: on Documenso's current default, some people legally cannot sign the document.

### Quick scan (`quick-scan.mjs`)

Answer to the speed item below. A deterministic Node script with no dependencies: 25 states in six groups (waiting, nothing there, things going wrong, being cut off, edge cases, ways of using it), each with regex signals, plus four problem detectors (mouse-only canvas, canvas with no ARIA, clickable non-buttons, images without alt). Score is weighted by what a missing state does to someone (3 / 2 / 1). Partly counts half, or a quarter when a problem was found.

**Documenso:** whole repo, 1,966 files in 0.6s, 80/100. Signing page only (`--scope` on the recipient routes, the two signing component folders and `packages/ui`), 184 files in under 0.1s, 65/100. Top 3 on both: keyboard, screen reader, offline.

Against the deep audit's 13 findings on the signing page:

| Deep finding | Quick scan |
|---|---|
| Keyboard navigation (blocker) | Caught. Points at `envelope-signer-page-renderer.tsx:419`, the same V2 canvas |
| Screen reader (blocker) | Caught, same canvas files |
| Signature methods restricted via API (blocker) | Missed. Needs tracing API to UI |
| Status page says "Sign up" (misleading) | Missed |
| Over-long text cleared (misleading) | Missed. Reports length limits as handled |
| Expired 2FA reported as invalid (misleading) | Missed |
| Offline, slow connection (nuisance) | Caught (not found) |
| PDF load error without retry (nuisance) | Missed. Retry exists elsewhere in scope |
| Link expires mid-session (nuisance) | Missed. Session copy exists on sign-in |
| Reduced motion, high contrast, print (optional) | Caught (not found) |

7 of 13, including 2 of 3 blockers. Everything it misses needs judgement about one screen, which is what the agents are for. That's the split: quick scan to hook, deep audit to find the story.

Known noise: the signature pad's drawing canvas is flagged as mouse-only even though the pad has Type and Upload tabs. `docs/`, `examples/` and `*-tests` folders are skipped because documentation sites polluted the first run (404, onboarding, conflict). Native apps (tested on the Swift drip-app) are refused instead of scored.

### Token cost

Asked for after the quick scan. Where the 525K went, and what replaces it:

| Step | Before | Now |
|---|---|---|
| Scanner (136K) | Agent reads CSS and components | `quick-scan.mjs --inventory`, 0.7s. Agent only if no colour tokens or fewer than 5 components |
| Enumerator (241K) | Explores the repo, lists all 150 states in full | Reads a script-made file list (`--entry` follows imports: 223 files from the signing route, 74 feature UI files) within a ~6,000-line budget; working states in one line |
| Auditor (148K) | Gets all states, searches broadly, writes all 150 back | Gets only likely gaps with `file:line` starting points; returns only those |

Checked: the script inventory gives the Documenso report the same palette as the agent's (primary hsl(95 71% 67%), destructive, 0.5rem radius, Inter). On FlyTabs it finds 40 BEM components, including 9 of the agent's 14 (`badge`, `card`, `tooltip`, `tabs` and `inline-select` have no modifiers, so they're missed). The report is unchanged when the Documenso audit is split into 13 audited plus 137 pre-classified states.

Measured on the Supabase run below: **288K subagent tokens against 525K (45% less)**. Scanner 0 (script), Enumerator 154K (was 241K), Auditor 134K (was 148K). The Auditor saved least: 56 tool calls for 33 states. Giving it fewer states, or splitting it by cluster, is the next lever.

Bugs found on the way: a light theme selector named `.dark-mode-disabled` was read as dark mode; a small Next.js API package made the monorepo look like a Next app; `assets/builds/` (compiled CSS) polluted the component list.

### Supabase Studio SQL editor (second example)

`examples/supabase-sql-editor/`, all inputs in `data/`. Entry files `apps/studio/pages/project/[ref]/sql/[id].tsx` and `index.tsx`: 637 files reached, 118 in the Enumerator's list. Enumerator: 128 states (94 one-line `works`). 95 pre-classified, 33 audited.

**Score 0/100. Three fixes lift it to 34.** 2 blockers, 8 misleading, 7 nuisances. Verified by hand before the report:
- **Long-running query, no cancel (blocker):** Run spins and is disabled; the only cancel is on Observability › Connections. Refresh doesn't stop the query on the server.
- **Session expired (blocker):** the snippet store is an in-memory valtio proxy (`sql-editor-state.ts:19`), so manual-save edits die on the reload after sign-in.
- **Offline (misleading):** on hosted Studio React Query pauses the run mutation offline (`onlineManager` is only forced online when `!IS_PLATFORM`), so the panel says "Running..." while nothing is sent, and the query goes out on reconnect.
- **Undetected destructive query (misleading):** ran Supabase's own `destructiveSqlRegex`. `DELETE` inside a `WITH` clause or a `DO` block gets no warning.

Quick-scan fixes this run needed: tsconfig comment stripping broke on `"@/*"`; bare `components/...` imports; app-shell layouts pulled in the whole app (now listed, not followed); theme tokens in a checked-in `build/css/`; `deg` in HSL tokens; colours built from `var()` are skipped instead of used.

**The score hits the floor.** 17 findings deduct 116 points, so a well-built product reads 0/100 and the number stops saying anything. Needs a decision (see open items).

### Scoring: likelihood and diminishing deductions

Eva's call after Supabase hit 0/100: most findings are edge cases where the user can still finish, so they shouldn't weigh like blockers everyone hits. The score now asks two questions per finding, whether the user can still finish (consequence) and whether real users will hit it (the Enumerator's likelihood), and deductions compound instead of adding:

| | Common | Edge case (×0.3) |
|---|---|---|
| Blocker | 20% (12% half-built) | 6% (3.6%) |
| Misleading | 10% (6%) | 3% (1.8%) |
| Nuisance | 4% (2.4%) | 1.2% (0.7%) |

score = 100 × ∏(1 − points/100). Fix badges show gains in order, so they add up to the lift.

| | Old | New |
|---|---|---|
| Documenso signing | 22 → 74 | **50 → 89** |
| Supabase SQL editor | 0 → 34 | **48 → 69** |

Top 3 fixes unchanged on both, so the mockups still hold. Documenso's three blockers take half its score; Supabase's are spread over two blockers and eight misleading states, most of them edge cases. Findings are tagged "Edge case" in the report.

### Open items

- [ ] `examples/flytabs-editor.html` had uncommitted changes from before this session (regenerated with the old script). Not included in this branch's commits. Decide whether to keep or discard.
- [ ] The Auditor doesn't emit `implementation`; either add it to `agents/auditor.md` or drop the field.
- [x] Speed. 15 minutes and 500K tokens per feature won't get roast-style adoption. Done as `quick-scan.mjs` (see above); the agents are now the deep mode.
- [x] Quick scan: follow imports from a route file (`--entry`).
- [x] Run the new pipeline on Supabase Studio and record per-agent tokens against the 525K baseline.
- [x] Score floor: fixed with likelihood weighting and compounding deductions (above).
- [ ] Likelihood now moves the score, so the Enumerator's `priority` needs the same scrutiny as the Auditor's consequence.
- [ ] Auditor cost: 134K for 33 states. Try splitting by cluster or pre-classifying more.
- [ ] Publish: the Documenso report as a public example, and a short write-up in the shape of "states are where interfaces stop being finished".

## /states skill (branch `states-skill`, 2026-09-25)

Direction: a Claude Code skill for people shipping UI with code + AI. Plan mode (describe a feature → states to build) and check mode (audit changed files/paths → findings with repro + fix). Check mode always runs three lens reviewers (actions, screens, a11y) in parallel; a single pass missed too much.

| Case | Single pass | Three lenses | Tokens (lenses) |
|---|---|---|---|
| Invoices fixture (8 planted) | 8/8 | — | 72K single |
| Documenso signing | 2/10 | 6/10 (4–5/6 must-find) | ~222K |
| Supabase SQL editor | 1–2/17 | 9/17 (4/10 must-find) | ~229K |
| Formbricks link survey (held out, no key) | — | 10 unique bugs; verifier: 8 confirmed, 2 plausible, 0 wrong | ~300K incl. rerun |

Plan mode: 26/27 required states across 3 cases, ~16K each.

Caveat: Documenso and Supabase answer keys are AI findings from earlier pipeline runs, not human-verified. Disputed items listed for manual repro (Sign up on end screens, destructive query severity, session expiry losing SQL).

Scan fixes found by the evals: rank files with actions above type/email/config files; follow one more hop to queue/api/submit files; `--include` to force files.

Open: session-expiry input loss still missed on Supabase; human verification of answer keys; cost ~225K per feature.

### Fix + show, and real-app runs (2026-09-26)

- Fix step and before/after browser screenshots (`show-states.mjs`, recipes per `skill/prompts/show.md`); report shows verified fixes. Invoices fixture: 10/10 fixes visible on screen, 36 → 100.
- Full runs on real apps: Excalidraw share link (8 findings, 1 disproved by its before screenshot, 4 fixed and shown, 44 → 85, ~340K tokens) and Actual Budget import (7 confirmed, 2 fixed and shown, 66 → 82, ~390K incl. 134K wasted on a scratch-path collision).
- Changes from those runs: unique run folder per run; verifier step in SKILL.md; `verify.json` written after looking at screenshots is the only source of "verified" (else "fixed in code, not verified"); a before shot that doesn't show a visible bug drops the finding; consequence disagreements settled by definition, not worst-wins; dev server identity check; show-states gains setup/storage/evaluate/drag/real-file upload, 60s timeout, step-named errors, merging `--only`, overlay hiding.
