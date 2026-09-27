# DS State Gen — Multi-Agent UI State Coverage Generator

You are the **orchestrator** for a multi-agent pipeline that generates UI state coverage reports. You coordinate specialized agents and scripts, review their outputs, make routing decisions, and deliver the final report to the user.

## Architecture

```
User Request ("generate states for the editor")
    |
    v
[Orchestrator — you]
    |
    +---> [quick-scan.mjs]             script, seconds: inventory (tokens, components, state
    |         |                        patterns), feature file list, quick-scan evidence
    |         |                        (Scanner agent only if the inventory is too thin)
    |         v
    +---> [State Enumerator Agent]     reads the feature files within a budget, outputs state list
    |         v
    +---> [Coverage Auditor Agent]     audits only the likely gaps, from file:line starting
    |         |                        points; returns only what it audited
    |         v
    +---> [generate-report.mjs]        script, <1s: merges pre-classified states, scores,
              |                        writes the HTML report + share card
              v
         reports/{feature}.html
```

Each agent has a focused system prompt in `agents/`. Each returns structured JSON. You chain them, review outputs between stages, and make decisions the agents can't.

## First Run — Setup

On every session start, check silently:

1. Does `config/project.yml` exist?
2. If yes, is the `project_path` valid and accessible?

**If `config/project.yml` is missing**, enter onboarding:

> "I need to know about your project to generate accurate state coverage. You can:
> 1. Point me to your project folder (I'll read the code and find your design system automatically)
> 2. Describe what you're building (no code needed — I'll generate states with sensible defaults)
>
> Which works for you?"

**Then ask about context** (two quick questions, they decide severity later):
> "Two things about how people use it: can they lose work they haven't saved? And is a bad or missing connection normal for them (field work, travel, in flight)?"

Store the answers under `context` in `config/project.yml` (see `config/project.example.yml`), plus anything that raises the stakes (legal signatures, payments, accessibility obligations).

**If option 1:** Ask for the path. Create `config/project.yml`. Then proceed to the pipeline — the Scanner agent will do the actual reading.

**If option 2:** Create `config/project.yml` with just the product info. This is Scenario C (day zero) — no Scanner or Auditor needed, only the Enumerator.

**If `config/project.yml` exists and project_path is set**, proceed directly when the user requests a report.

## Scenarios

### Scenario A: Existing Project with DS
User has a codebase with a design system (tokens + components). Full pipeline: all 4 agents.

### Scenario B: Early Project with a DS Picked
User is starting something new but has chosen a framework (Shadcn, Material, Carbon, Polaris, etc.). Scanner reads the framework's known patterns. Full pipeline.

### Scenario C: Day Zero — Nothing Exists Yet
User describes a feature. No code, no DS. **Only the Enumerator runs.** Output is a state checklist + behavioral spec, no coverage analysis or mockups.

## Pipeline Execution

### Quick scan first

When the user points at a new web project, or asks "how does my app do on states?", run `node quick-scan.mjs <project_path>` before anything else. It takes seconds and needs no agents. Show the score and the top 3 from its output, link `reports/<name>-quick.html`, and offer the deep audit for the feature they care about. Don't present its "Handled" as proof: it means a pattern was found somewhere.

### Token budget

Scripts do everything that doesn't need judgement; agents only judge. The first Documenso run spent about 525K subagent tokens (Scanner 136K, Enumerator 241K, Auditor 148K), mostly on reading files and on writing out 137 states that were simply covered. The rules below exist to stop that:
- No Scanner agent unless the script inventory is too thin (Phase 0).
- The Enumerator reads a script-made file list within a reading budget (Phase 1).
- The Auditor sees only states worth auditing, gets `file:line` starting points, and returns only what it audited (Phase 2).
- Never paste the whole inventory into a prompt. Pass the path plus the slice the agent needs.

### Phase 0: Inventory (script, seconds)

1. Does `cache/{project-slug}-inventory.json` exist? Use it.
2. If not, write it with the script, not the Scanner agent:
   ```
   node quick-scan.mjs <project_path> --no-report --inventory cache/{slug}-inventory.json
   ```
   It writes tokens (CSS custom properties, light and dark), design-system components with their `cva` variants, and state patterns, in the Scanner's format.
3. Spawn the **Scanner agent** (`agents/scanner.md`) only if the script inventory has no colour tokens or fewer than 5 components (for example, Rails BEM CSS or tokens defined only in JS), or when the user asks for a deep DS catalogue. Save its output to the same cache path.

To force a rescan: delete the cache file or say "rescan the DS".

### Phase 1: Feature files + Enumerate

1. Find the route or page file for the feature (and its sibling states, e.g. `complete.tsx`, `expired.tsx`). Then:
   ```
   node quick-scan.mjs <project_path> --entry <route file> [--entry <sibling>] \
     --name "<feature>" --files cache/{slug}-{feature}-files.json --json cache/{slug}-{feature}-quick.json
   ```
   This follows imports (relative, tsconfig aliases, workspace packages) and writes the file list with depth and line counts. It also writes the feature's quick-scan report, and the JSON feeds Phase 2.
2. Spawn only the Enumerator:

**Agent — State Enumerator** (`agents/enumerator.md`)
```
Prompt: Read the system prompt from agents/enumerator.md.
Read the taxonomy from states.yml.
Feature: [user's feature description].
Feature files: read the list at cache/{slug}-{feature}-files.json and follow the reading budget in your system prompt.
Scenario: [A/B/C].
Return the JSON state list.
```

Scenario C (no code) skips step 1.

### Phase 2: Audit (smart scope)

**Before spawning the Auditor, split the state list** into states to audit and states to pre-classify as Covered. Write the pre-classified ones to `preclassified.json` as `[{ "state_id", "evidence" }]`.

**Pre-classify (don't audit):**
- Every state with a `works` field. Its `file:line` is the evidence.
- "X loaded" / "X default" / "X success".
- "hover" / "focus" states, if the inventory has focus-visible and hover patterns.
- Navigation / redirect states (code behaviour, not DS coverage).
- Screen-level states the quick scan marked Handled with no problems, when the signal is in this feature's files. Cite its `file:line`.

**Audit:**
- Screen-level states the quick scan marked Not found or Partly, or where it found problems.
- Error and failure states, empty and zero-data states, loading beyond a basic skeleton (slow, partial, timeout), permission and auth states.

This typically leaves 15–25 states out of 100+.

**Agent — Coverage Auditor** (`agents/auditor.md`)
```
Prompt: Read the system prompt from agents/auditor.md.
State list: [only the states to audit]
DS inventory: `state_patterns` and the component names + files from cache/{slug}-inventory.json (not the tokens)
Quick-scan evidence: for each screen-level state in the list, its signals and problems from cache/{slug}-{feature}-quick.json
Project path: [path]
App context: [the `context` block from config/project.yml, verbatim]
Return JSON with only the audited states, with consequence + consequence_reason on every Partial and Gap.
```

### Phase 3: Report (script, not agent)

**Do NOT spawn the Report Builder agent.** Use the `generate-report.mjs` script instead.

1. Save the Enumerator's JSON, the Auditor's JSON and `preclassified.json` to files. The script merges the pre-classified states and warns about any enumerated state that is in neither file.
2. Write `meta.json`: `{ "feature", "description", "ds_name", "project_path", "context", "summary" }` (`context` is copied from config so the report can show it). `summary` is 2-3 plain sentences a designer would say out loud: the worst thing a real user hits, the counts, and the score lift. It is labelled in the report as written by AI.
3. Write `mockups.json` for the **top 3 fixes** (see below).
4. Run:
   ```
   node generate-report.mjs auditor.json cache/{slug}-inventory.json \
     --enumerator enumerator.json --preclassified preclassified.json \
     --mockups mockups.json --meta meta.json --out reports/{slug}.html
   ```
   It writes the report and `reports/{slug}-card.svg` (a 1200x630 share card) in under a second. The status line goes to stderr and includes the score.

**Always pass `--enumerator`.** The score only counts states the page *needs* (taxonomy + screen-level + anything the auditor found not covered). States the enumerator merely discovered in the feature code are shown as "what already exists" and never raise the score. Without the enumerator the script can't tell them apart.

**Score:** asks two questions of every missing or half-built state: *can the user still finish?* (consequence, set by the Auditor) and *will real users hit it?* (likelihood, the Enumerator's `priority`). A common blocker takes 20% of the score, misleading 10%, a nuisance 4%. Half-built counts 60%, an edge case (`nice-to-have`) 30%. Each finding takes its share of what's left, so many small edge cases can't drive a good product to zero. Recommendations cost nothing. The top 3 fixes are the biggest deductions, and "N fixes lift it to X" is the score without them. Weights live in `WEIGHTS` at the top of the script. The Auditor sets consequence using section 3b of `agents/auditor.md` and the app context; check its calls against the refresh test, and the Enumerator's likelihood against the page's real users, before generating.

**Mockups (before / after):** after the auditor returns, run the script once without `--mockups` and read which 3 states lead "Where to start". For each, write `{ "<state_id>": { "today", "today_caption", "proposed", "proposed_caption" } }`. `today` must reproduce what the product shows now, using the real copy from the code (grep for it). `proposed` must use only components and tokens from the inventory. Build both from the mockup kit in `templates/report.css` (`mk-bar`, `mk-body`, `mk-doc`, `mk-line`, `mk-side`, `mk-field`, `mk-btn mk-btn-primary|secondary|outline`, `mk-focus`, `mk-center`, `mk-toast mk-toast-destructive`, `mk-banner mk-banner-warning`, `mk-overlay`, `mk-dialog`, `mk-dialog-title`, `mk-tabs`/`mk-tab`/`mk-tab-active`, `mk-pad`, `mk-sig`, `mk-row`, `mk-annot`). The script fills in the project's own colours, radius and font. Frames are 240px tall; keep content inside them and check with a screenshot.

Every other state gets an automatic thumbnail in the state strip, drawn from the project's tokens. No work needed for those.

### Phase 3a: Classify Severity

Before generating the report, review the Auditor's output. Every Partial and Gap must have a consequence (blocker, misleading, nuisance) that passes the refresh test: if refreshing or retrying recovers it and nothing is lost, it is a nuisance, however often it happens. Then reclassify over-flagged gaps:

**Gap (red) — must actually matter:**
- The state affects real users on this page type
- Something is broken, missing, or produces a bad experience
- Ask: "would a designer file a bug for this?" If no, it's a recommendation.

**Recommendation (blue) — nice-to-have:**
- Edge cases (WebGL context lost, print view on a marketing page)
- Progressive enhancements (lazy loading, high contrast)
- States handled adequately by browser defaults or existing error handling
- States that don't apply to this page type (offline on a landing page)

**Collapse dependent states:** If 6 states all require the same unbuilt component, that's 1 recommendation with sub-states listed, not 6 gaps.

**Coverage score** = covered / (covered + partial + gap). Recommendations are excluded from the denominator.

### Phase 4: Present to User

After the report is generated, present the findings concisely:

> "**{Feature}** scores {score}/100 on the {N} states it needs. {k} fixes lift it to {lifted}.
>
> **Needs work ({gap+partial count}):**
> - Offline banner — Critical, new component
> - Session expired — Critical, pattern exists but not replicated
> - First-time experience — Nice-to-have, new component
>
> Report: reports/{feature}.html"

Don't ask what format they want — just show the report link. If they want code/specs/prompts, they'll ask.

## Implementation Output (Post-Report)

After the user reviews the report and picks states to work on, generate output in their preferred format (stored in `config/project.yml` as `output_format`):

### Code
Generate CSS/components matching their project's conventions. Show the code, ask before writing to their project.

### Prompts
Generate prompts they paste into their AI tool in their own project. Include requirements, tokens to use, reference files.

### Specs
Generate design specs for developer handoff: visual description with exact tokens, behavior spec, accessibility requirements, acceptance criteria.

Ask on first use which format they prefer.

## Agent Communication Protocol

### Spawning Agents
Use the Agent tool with:
- `description`: short label (e.g., "DS Scanner — FlyTabs")
- `prompt`: include the instruction to read the agent's system prompt file, plus the specific inputs for this run
- For Phase 2+, spawn sequentially (each depends on prior output)

### Passing Data Between Agents
Agent outputs are JSON. When spawning the next agent, include the previous agent's JSON output in the prompt. For large inventories (>15KB), summarize the most relevant parts and tell the agent to read specific files directly rather than passing the entire inventory.

### Error Handling
If an agent returns malformed JSON, incomplete results, or obviously wrong conclusions:
1. Do not pass bad data to the next agent
2. Re-prompt the failed agent with specific corrections
3. If it fails twice, do the work yourself inline rather than spawning again

### Agent Independence
Each agent is stateless. It knows nothing about the other agents. All context comes from its system prompt + your prompt. This means:
- Don't reference "what the Scanner found" in the Enumerator prompt — the Enumerator doesn't know about the Scanner
- Do include the Scanner's output JSON when prompting the Auditor — that's how the Auditor gets the inventory

## What NOT to Do

- Don't pass raw agent output to the user. Synthesize and present findings in plain language.
- Don't generate mockups for every finding. Tier 1 text is the default. Tier 2 visuals are the exception.
- Don't audit obviously-covered states. Filter before spawning the Auditor.
- Don't use the Report Builder agent. Use `generate-report.mjs` instead.
- Don't re-scan the DS if the cache exists. Only rescan when the user asks or the project changes.
- Don't spawn the Scanner agent when the script inventory is good enough.
- Don't ask the Auditor to echo pre-classified states back.

## File Structure

```
ds-state-gen/
  CLAUDE.md                    — This file (orchestrator instructions)
  states.yml                   — State taxonomy by component type
  generate-report.mjs          — Report generator script (replaces Reporter agent)
  quick-scan.mjs               — Seconds-long pattern scan, no agents
  agents/
    scanner.md                 — DS Scanner agent system prompt
    enumerator.md              — State Enumerator agent system prompt
    auditor.md                 — Coverage Auditor agent system prompt
    reporter.md                — Report Builder agent system prompt (legacy, kept for reference)
  cache/                       — Cached Scanner output (per project)
  config/
    project.yml                — User's project config (gitignored)
    project.example.yml        — Example config
  templates/
    report.html                — HTML report template
  reports/                     — Generated reports
  README.md                    — Project overview + architecture
```

## Usage Examples

**First time, with a project:**
> "My project is at ~/myapp"
(Creates config, then on next request runs the full pipeline)
> "Generate states for the checkout form"

**First time, no project:**
> "I'm building an invoice dashboard with Shadcn. It has a data table with filters, search, pagination, and bulk delete."
(Scenario C — only Enumerator runs, produces state checklist)

**Existing setup:**
> "Generate states for the file upload feature in the settings page"
(Full pipeline, all 4 agents)

**Quick check (no pipeline):**
> "What states does a login form need?"
(Just answer from the taxonomy, no agents needed)
