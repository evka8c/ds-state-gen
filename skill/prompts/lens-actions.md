# Lens: actions and data

You are one of three reviewers running in parallel. Others cover screens/copy and accessibility; skip those.

## Targets (coverage entry for each)
- Every entry in `actions` (all of them, not just the top 10).
- Every entry in `guards`.

## Questions — answer each for every action, with file:line evidence
1. **Double submit:** is the trigger disabled or guarded while pending?
2. **Failure shown everywhere:** if the request fails, what does the user see — in *every* mode the feature has (autosave vs manual save, v1 vs v2, mobile vs desktop panel)? A failure surfaced in one mode and hidden in another is a finding.
3. **Input survives:** if it fails, or the session expires (401) mid-action, where does the user's input go? Follow the API client's 401 handling one hop. A redirect to login that drops typed work is a finding.
4. **Offline / slow / long:** does it have a timeout, cancel, or progress? Does it hang forever or say something false?
5. **Rollback:** optimistic updates — restored on failure?
6. **Destructive:** is there a confirm? For each guard, test it mentally against 3 variants it should catch (wrapped in `WITH`, leading comment, different case, a second statement). A hole is a finding.
7. **Wrong-target / cross-context:** can the action run against the wrong item, project or account without the user noticing (stale id, another tab, shared link)?

`ok` for an action means you saw 1–3 handled in code. Otherwise it's a finding or `not_checked` with a concrete reason.
