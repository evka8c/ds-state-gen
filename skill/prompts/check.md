# /states check: judge the doubtful states

You get a scope JSON from `states-scan.mjs` and, maybe, an app `context` block. The script already read the code and matched patterns. Your job is judgement only: decide which doubtful states really hurt a user, prove it with a repro, and propose a fix built from the project's own components. One pass. Whole run under ~80K tokens.

## 1. What to judge, in this order

The bugs that matter most live in the feature's own actions (sign, run, save, delete, verify, upload), not in generic states. So:

1. **`actions`** — the feature's async actions, ranked, with signals (`pending`, `error`, `disabled_while_pending`, `confirm`, `timeout_or_cancel`). For each of the top actions, read its handler and the control that triggers it, and answer:
   - Double submit: is the trigger disabled or guarded while pending?
   - Failure: if the request fails, what does the user see? Is their input kept? Does loading reset?
   - Session expiry (401) mid-action: is input kept, and is the message true? Follow the API client one hop if needed.
   - Offline or very slow: does it hang forever, or say something false?
   - Destructive or irreversible: is there a confirm, and does any `guards` entry have holes (a regex that misses a variant)?
   - Long-running: can the user cancel or see progress?
2. **`guards`** — test each one mentally against 2–3 variants of what it should catch.
3. **`a11y`** — hints like clickable divs, canvas with no keyboard path, icon buttons with no name. Confirm by reading the cited line; these are code facts, not runtime checks.
4. **`states`** and **`screen_level`** — doubtful taxonomy states. Judge the required ones.
5. **Sibling screens** in scope (e.g. `complete`, `expired`, `rejected` routes): skim each once. Does the copy and the call to action fit the person who lands there?

### Coverage is required

Before writing findings, fill `coverage`: one entry for **each of the top 10 `actions`**, **each sibling screen/route file in scope**, **each `guards` entry** and **each `a11y` hint**. Each entry is `{ target, verdict: "finding" | "ok" | "not_checked", ref }`, where `ref` is the finding id, the `file:line` that shows it's fine, or the reason it wasn't checked. For an action, `ok` means you read its handler and saw double-submit, failure and 401 handled. An output where a target is missing, or `not_checked` while you still have reads left, is invalid. Plan reads so every target gets one.

- `handled: [{id, at}]` — trust these. Don't open files for them or list them.
- `no_signal: [ids]` — skip unless one clearly applies to what you read.

## 2. Reading budget

- Max **25 file reads** and **3000 lines** total. Count them; report `reads_used`.
- Each read starts at a cited `file:line` and covers ±60 lines. Read a whole file only if it is under 200 lines.
- Max **12 greps**, each for a specific string (a handler name, an error code, exact copy, `401`, `navigator.onLine`, `disabled=`). Only inside the project root.
- Read files in `scope.files` and `scope.dropped.top`, plus one hop to anything they import or call when the answer is there (the API client's 401 handling, the error map, the component that renders the error). Never list directories, never read tests or docs.
- Batch: one read usually settles several questions. Plan your reads from the cited lines before starting.
- `not_checked` with why `"budget"` is allowed **only when you have used all 25 reads**. Stopping early with open questions is a failure.
- `"needs runtime check"` is only for behaviour the code can't show (real timing, browser quirks). Read the code first; if the code answers it, decide.

## 3. Deciding

For each judged state, open the evidence and ask: what does the user see if this happens right now? Then one of:
- **Fine** — the code handles it. Add to `checked_ok` with one-line evidence (`file:line` + what handles it).
- **Finding** — it's missing or wrong, and you can write a concrete repro. No repro, no finding.
- **Can't tell** — `not_checked` with why.

Check recovery as a fact, not a guess: does data save per action or only at the end? Does a refresh land somewhere sensible? Does the error path reset `loading`?

## 4. Discovered states (max 8)

The best past findings were not in the taxonomy. While reading, watch for:
- **Async action without a failure path**: `await` / `mutate` / `fetch` with no `catch`, `onError`, or a catch that only logs. Also: `setLoading(true)` with no reset on error → stuck spinner.
- **Timers and expiry**: countdowns, `expiresAt`, TTLs. Does the UI act on expiry, or does the button stay live and the server then say something wrong? (Documenso: 2FA Verify stays enabled after the code expires, then says "Invalid code".)
- **Disabled logic that misses a case**: `disabled={!isValid}` that ignores pending, expired, or offline.
- **Error mapping that lies**: one catch-all message for several server codes; a wrong message for a known code.
- **Guards with holes**: regex/allowlists that miss a variant (Supabase: destructive-SQL check misses `DELETE` inside a `WITH`), client validation the server doesn't match, or vice versa.
- **Optimistic updates** with no rollback on failure.
- **Dialogs that stay open** after the action fails or the thing they act on is gone.

Add one only if you saw it in scope code and it clearly harms a user. `kind: "discovered"`, `state_id: null`.

## 5. Consequence

Rank by what happens to the user, not how often. First ask: **does refreshing or retrying fix it, with nothing lost?** If yes, it is at most a nuisance.

- **blocker** — the user can't finish, and refresh/retry doesn't help, or work is lost. (No keyboard path to a required control; crash on a reachable config; dead end.)
- **misleading** — the screen says something false so the user acts wrongly. ("Invalid code" when it expired; success after failure; "Sign up" for someone who has an account; enabled button that does nothing.)
- **nuisance** — slowed down, has to refresh/retry, carries on with nothing lost. (Error without a retry button; plain spinner on a slow load.)
- **recommendation** — edge case or enhancement nobody would file a bug for; state that doesn't fit this page type; handled acceptably by browser defaults. Costs nothing in the score.

App context shifts levels:
- `unsaved_work: yes|partly` — network loss, session expiry, crashes that discard input → blocker.
- `poor_connectivity_is_normal: yes` — offline/slow with no explanation → at least misleading; blocker if work is lost.
- `stakes` (legal, payment, medical, accessibility) — access failures (keyboard, screen reader) → blocker even with a workaround.

If `context` is absent: assume `unsaved_work: no`, `poor_connectivity_is_normal: no`, no special stakes. Don't ask. Set `context_assumed: true` in the output.

`consequence_reason` is one sentence naming the recovery fact you checked.

## 6. The fix

- Use components from `inventory.components` and patterns from `inventory.state_patterns`. Name them exactly. If nothing fits, say "new" and name the closest base to extend.
- Describe the behaviour: what the user sees, when, and how they get out.
- `sketch`: a minimal diff-like snippet (≤ 15 lines) in the project's idioms — same imports, same i18n wrapper (`<Trans>`, `t\`\``), same class style. Use real identifiers from the code you read. It's a sketch, not a patch; the apply step comes after the user confirms.
- **Collapse**: if several findings need the same missing piece (one offline banner, one retry wrapper), make one finding with the others in `also_covers`. Consequence = the worst of them.

## 7. Every finding must have

`where` (file:line you read), `repro` (steps a person can do: "open the link, wait 10 min, enter the code, click Verify"), `today` (what they see, real copy from the code in quotes), `consequence` + `consequence_reason`, `fix`. Missing any → drop it or move it to `not_checked`.

`confidence: high` when you read the exact path end to end; `medium` when one hop is inferred (e.g. server message from a map you didn't open). Don't emit low-confidence findings.

## 8. Worked example (Documenso signing)

```json
{
  "id": "F1",
  "title": "Expired 2FA code: Verify stays enabled, then says the code is wrong",
  "state_id": null,
  "kind": "discovered",
  "consequence": "misleading",
  "consequence_reason": "Retyping the same code fails again; the user thinks they mistyped and never asks for a new code. Refresh doesn't explain it.",
  "where": [
    {"file": "apps/remix/app/components/general/document-signing/access-auth-2fa-form.tsx", "line": 274},
    {"file": "apps/remix/app/components/general/document-signing/document-signing-complete-dialog.tsx", "line": 173}
  ],
  "repro": "Open a signing link that needs 2FA, request a code, wait until the countdown turns red, enter the code, click Verify & Complete.",
  "today": "Countdown turns red, button stays enabled; after submit: \"Invalid verification code. Please try again.\"",
  "fix": {
    "summary": "When the countdown hits zero, disable Verify and show an inline expiry message with a Resend code button; map the server's expiry error to the same copy.",
    "components": ["Button", "FormMessage"],
    "behaviour": "At 0s: Verify disabled, text-destructive message 'This code has expired', secondary Button 'Send a new code' that restarts the timer.",
    "sketch": "- disabled={!form.formState.isValid}\n+ disabled={!form.formState.isValid || millisecondsRemaining <= 0}\n+ {millisecondsRemaining <= 0 && (\n+   <FormMessage><Trans>This code has expired.</Trans></FormMessage>\n+   <Button variant=\"secondary\" onClick={onResend}><Trans>Send a new code</Trans></Button>\n+ )}"
  },
  "also_covers": [],
  "confidence": "high"
}
```

## 9. Output

`coverage` comes first in the JSON, then `findings`.

Return only JSON matching `skill/schema/findings.schema.json`. No prose before or after. Sort `findings` by consequence (blocker, misleading, nuisance, recommendation), then confidence. Keep `checked_ok` and `not_checked` entries to one line each. `feature_summary`: one sentence on what the scoped code does.
