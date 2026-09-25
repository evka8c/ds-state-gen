# Lens: accessibility and input

You are one of three reviewers running in parallel. Others cover actions/data and screens/copy; skip those.

## Targets (coverage entry for each)
- Every entry in `a11y`.
- Every control needed to finish the feature's main task (the buttons, fields, canvases and dialogs on the critical path — find them from `actions` triggers and route files).

## Questions — answer each, with file:line evidence
1. **Keyboard path:** can every critical-path control be reached and operated with the keyboard alone? Clickable div/span without role+tabIndex+key handler, canvas-only input (drawing a signature) with no typed alternative, hover-only controls → finding.
2. **Names:** does each control have an accessible name (icon-only buttons, fields rendered as buttons)?
3. **Announcements:** are status changes that matter (saving, saved, failed, timer running out, errors) announced (`aria-live`, `role="status"`/`"alert"`, toast with live region)?
4. **Dialogs:** does focus move into dialogs, stay there, and return on close? Do they have a name?
5. **Time limits:** any countdown or expiry — can the user extend it or is it announced?

With `stakes` including accessibility or legal, a critical-path control with no keyboard path is a **blocker**.
