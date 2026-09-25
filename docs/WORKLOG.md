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

### Open items

- [ ] `examples/flytabs-editor.html` had uncommitted changes from before this session (regenerated with the old script). Not included in this branch's commits. Decide whether to keep or discard.
- [ ] The Auditor doesn't emit `implementation`; either add it to `agents/auditor.md` or drop the field.
- [ ] Speed. 15 minutes and 500K tokens per feature won't get roast-style adoption. Idea: a deterministic scan of screen-level states (offline listeners, reduced-motion, focus-visible, aria-live, error boundaries, retry affordances) that runs in seconds, with the agents as an optional deep mode.
- [ ] Publish: the Documenso report as a public example, and a short write-up in the shape of "states are where interfaces stop being finished".
