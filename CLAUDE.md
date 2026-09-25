# DS State Gen — Multi-Agent UI State Coverage Generator

You are the **orchestrator** for a multi-agent pipeline that generates UI state coverage reports. You coordinate four specialized agents, review their outputs, make routing decisions, and deliver the final report to the user.

## Architecture

```
User Request ("generate states for the editor")
    |
    v
[Orchestrator — you]
    |
    +---> [1. DS Scanner Agent]        reads codebase, outputs component inventory (JSON)
    |         |
    +---> [2. State Enumerator Agent]  reasons about states, outputs state list (JSON)
    |         |              (Scanner + Enumerator run in PARALLEL — independent inputs)
    |         v
    +---> [3. Coverage Auditor Agent]  takes inventory + state list, searches codebase,
    |         |                        outputs coverage matrix (JSON)
    |         v
    +---> [4. Report Builder Agent]    takes matrix + inventory + tier decisions,
              |                        outputs HTML report file
              v
         reports/{feature}.html
```

Each agent has a focused system prompt in `agents/`. Each returns structured JSON (except Reporter, which writes HTML). You chain them, review outputs between stages, and make decisions the agents can't.

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

### Phase 0: Cache Check (instant)

Before spawning any agents, check for cached data:

1. **Scanner cache:** Does `cache/{project-slug}-inventory.json` exist?
   - Yes → skip Scanner agent entirely, load from cache
   - No → Scanner runs, output saved to cache after
2. **Enumerator does NOT need caching** — its output is feature-specific every time.

The DS inventory (tokens, components, patterns) rarely changes between features. Caching the Scanner eliminates ~4 minutes per run.

To force a rescan: delete the cache file or say "rescan the DS".

### Phase 1: Enumerate (+ Scanner if uncached)

**If Scanner cache miss:** Spawn Scanner + Enumerator in parallel (same as before).

**If Scanner cache hit:** Only spawn the Enumerator. Pass the cached inventory path.

**Agent — State Enumerator** (`agents/enumerator.md`)
```
Prompt: Read the system prompt from agents/enumerator.md.
Read the taxonomy from states.yml.
Feature: [user's feature description].
Feature files to read: [specific files if user pointed to them, or files you identified].
Scenario: [A/B/C].
Return the JSON state list.
```

**Agent — DS Scanner** (only if cache miss) (`agents/scanner.md`)
```
Prompt: Read the system prompt from agents/scanner.md.
Scan the project at [project_path].
CSS paths to prioritize: [from config/project.yml css_paths].
Return the JSON inventory.
```

After Scanner returns, save output to `cache/{project-slug}-inventory.json`.

### Phase 2: Audit (smart scope)

**Before spawning the Auditor, filter the state list.** Don't audit all states — most "loaded", "default", "hover", and "success" states are obviously covered. Only audit states likely to be gaps:

**Always audit (high gap probability):**
- Screen-level states (offline, first-time, session expired, reduced motion, high contrast, print)
- Error and failure states
- Empty and zero-data states
- Loading states beyond basic skeleton (slow connection, partial load, timeout)
- Permission and auth states
- Accessibility states (keyboard nav, screen reader)

**Skip auditing (almost always covered):**
- "X loaded" / "X default" / "X success" — mark as Covered automatically
- "hover" / "focus" states — if the DS has focus-visible and hover patterns, mark Covered
- Navigation / redirect states — these are code behavior, not DS coverage
- States where the Enumerator already cited the exact file:line implementing it

This typically reduces ~90 states to ~20 that actually need codebase searches, cutting Auditor time from ~5 minutes to ~1-2 minutes.

**Agent — Coverage Auditor** (`agents/auditor.md`)
```
Prompt: Read the system prompt from agents/auditor.md.
State list: [FILTERED list — only states that need auditing]
Pre-classified states: [list of state IDs auto-marked as Covered with reason]
DS inventory: [JSON from Scanner or cache]
Project path: [path]
App context: [the `context` block from config/project.yml, verbatim]
Return the JSON coverage matrix (include both audited and pre-classified states), with consequence + consequence_reason on every Partial and Gap.
```

### Phase 3: Report (script, not agent)

**Do NOT spawn the Report Builder agent.** Use the `generate-report.mjs` script instead.

1. Save the Enumerator's JSON and the Auditor's JSON to files.
2. Write `meta.json`: `{ "feature", "description", "ds_name", "project_path", "context", "summary" }` (`context` is copied from config so the report can show it). `summary` is 2-3 plain sentences a designer would say out loud: the worst thing a real user hits, the counts, and the score lift. It is labelled in the report as written by AI.
3. Write `mockups.json` for the **top 3 fixes** (see below).
4. Run:
   ```
   node generate-report.mjs auditor.json cache/{slug}-inventory.json \
     --enumerator enumerator.json --mockups mockups.json --meta meta.json \
     --out reports/{slug}.html
   ```
   It writes the report and `reports/{slug}-card.svg` (a 1200x630 share card) in under a second. The status line goes to stderr and includes the score.

**Always pass `--enumerator`.** The score only counts states the page *needs* (taxonomy + screen-level + anything the auditor found not covered). States the enumerator merely discovered in the feature code are shown as "what already exists" and never raise the score. Without the enumerator the script can't tell them apart.

**Score:** starts at 100 and deducts by **consequence**, not by how often a state happens. Blocker (can't finish; refresh doesn't help) costs 20, or 12 if half-built. Misleading (the screen says something false) costs 10 or 6. Nuisance (refresh or retry recovers it) costs 4 or 2. Recommendations cost nothing. The top 3 fixes are the biggest deductions, and "N fixes lift it to X" is their sum. Weights live in `WEIGHTS` at the top of the script. The Auditor sets consequence using section 3b of `agents/auditor.md` and the app context; check its calls against the refresh test before generating.

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
- For Phase 1, spawn both agents in a single message (parallel execution)
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

## File Structure

```
ds-state-gen/
  CLAUDE.md                    — This file (orchestrator instructions)
  states.yml                   — State taxonomy by component type
  generate-report.mjs          — Report generator script (replaces Reporter agent)
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
