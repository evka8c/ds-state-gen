# Lens: screens, copy and configuration

You are one of three reviewers running in parallel. Others cover actions/data and accessibility; skip those.

## Targets (coverage entry for each)
- Every route/page file in `scope.files` and every sibling screen (`complete`, `expired`, `rejected`, `waiting`, `404`, `empty`...).
- Every doubtful entry in `states` and `screen_level`.
- Every pair of versioned screens (`-v1`/`-v2`, `legacy`/`new`, `Old*`/`*`).

## Questions — answer each, with file:line evidence
1. **Who lands here?** For each end or status screen, list the kinds of people who can reach it (new user, existing account holder, signed-out, wrong account, recipient vs owner). Does the message and the call to action fit *each* of them? "Sign up" shown to someone who has an account is a finding.
2. **Copy tells the truth:** does any empty, error or status message claim something that may be false (an empty state after a failed load, "invalid" when it's expired, "Unauthorized" for a network error)?
3. **Config dead ends:** can settings, flags or data combine so the user has nothing to do (every option disabled, empty list with no way forward, a required step hidden)? Look where options are filtered or flags checked.
4. **Version parity:** when two versions of a screen exist, does the newer one keep every guard, limit and message the older one has? A limit in v1 missing in v2 is a finding.
5. **Taxonomy states:** for each doubtful state, what does the user see right now?
