# Evals for `/states`

Checks that `/states` finds the real gaps (recall), that what it reports is real (precision), and that it leaves correctly handled states alone.

## What's here

| Path | What it is |
|---|---|
| `cases/documenso-signing/case.json` | Answer key from the Documenso signing-page run (13 findings verified by hand; see `docs/WORKLOG.md`). 10 expected: 6 must-find (3 blockers, 3 misleading), 4 optional nuisances, plus 3 known recommendations. |
| `cases/supabase-sql-editor/case.json` | Answer key from the Supabase Studio SQL editor run. 17 expected: 10 must-find (2 blockers, 8 misleading, including DELETE inside `WITH` / `DO` not triggering the destructive warning), 7 optional nuisances. |
| `cases/invoices-fixture/case.json` | Answer key for the planted-bug fixture. 8 expected: 5 must-find, 3 optional. `ANSWERS.md` beside it explains each one. |
| `fixtures/invoices-app/` | Small React + TS invoices app with a shadcn-style `components/ui/`. Point `/states` at it. It holds no answers: keep it that way. |
| `cases/plan/*.json` | Plan-mode cases: invoice table, signup with email verification, file upload to a project. |
| `samples/` | Hand-written runs used to test the scorer (perfect run and partial run for the fixture, one plan output). |
| `score.mjs` | The scorer. Node, no dependencies. |

The two real-repo cases point at local clones (`repo`, with `repo_commit`). Line numbers were re-checked against those clones on 2026-09-25. If you re-clone, check `evidence` again before trusting a miss.

## Case format

```json
{
  "repo": "...", "paths": ["files or folders/ the run should cover, relative to repo"],
  "context": { "unsaved_work": "...", "poor_connectivity_is_normal": false, "stakes": "..." },
  "expected": [{ "id", "title", "match": { "files": [...], "keywords": [...] },
                 "evidence": ["file:line"], "consequence": "blocker" | ["misleading", "blocker"], "must_find": true }],
  "recommendations": [{ "id", "keywords" }],
  "must_not_flag": [{ "state", "keywords", "files", "why", "evidence": "file:line" }]
}
```

`must_find` is true for blockers and misleading states, false for nuisances. `consequence` can be a list when more than one call is defensible.

## Running

Save the `/states` output as JSON in this shape:

```json
{ "findings": [{ "title", "state_id", "consequence", "where": [{ "file", "line" }], "repro", "today" }],
  "checked_ok": ["states it checked and found handled"] }
```

Then:

```
node evals/score.mjs evals/cases/invoices-fixture/case.json run.json          # text summary
node evals/score.mjs evals/cases/invoices-fixture/case.json run.json --json   # JSON summary
node evals/score.mjs evals/cases/plan/invoice-table.json plan.json            # plan mode
```

Plan output is `{ "states": [{ "id", "name", "description" }] }`. Exit code is 1 if a must-find item is missed, a handled state is flagged, or (plan mode) a required state is missing.

## How matching works

- **Audit.** A finding matches an expected item when one of its `where` files matches one of `match.files` (path suffix, or a folder ending in `/`) and its text (title, state_id, repro, today) contains at least one of `match.keywords`. With no file overlap it needs two keywords, and is listed under "keyword-only matches" for a human to check. A finding that hits a `must_not_flag` entry at least as strongly as the expected item is not matched. Assignment is one-to-one, strongest first.
- Each unmatched finding lands in one bucket: **duplicate** of an item already matched, **recommendation** (known, or consequence `recommendation`), **false alarm** (hits a `must_not_flag` state), or **unmatched: needs human review**.
- **Recall**: matched / expected, overall and for `must_find` only.
- **Precision (lower bound)**: matched / (matched + unmatched + false alarms). Duplicates and recommendations don't count. When a human confirms an unmatched finding is real, add it to the case's `expected` so the next run scores it.
- **Consequence agreement**: of matched items, how many have a consequence in the accepted list.
- `checked_ok` entries that name a `must_not_flag` state are reported as confirmed OK.
- **Plan**: each `expected_states` entry is found if any listed state contains one of its keywords. `distinct_from` means it has to be a different state from the one that matched the other id (so "empty" and "filtered empty" can't be the same line). `required: false` items only count toward "all coverage". Any state that hits `must_not` is reported as irrelevant.

Keyword matching is deliberately loose. Read the unmatched and keyword-only lists before trusting a number.

## Sanity baselines

- `samples/invoices-perfect.json`: 100% recall, precision and agreement, exit 0.
- `samples/invoices-partial.json`: 3/8 recall, 2/5 must-find, one false alarm (search no-results), one unmatched (offline), one consequence miss, exit 1.
- The original auditor outputs in `examples/*/data/auditor.json`, converted to the findings shape, score 100% recall on both real-repo cases. That's a check that the keys are consistent with the runs they came from, not a measure of the skill.
