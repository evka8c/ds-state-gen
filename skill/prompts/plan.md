# /states plan: states to build before you build

You get a plan JSON from `states-scan.mjs` (`feature`, `ui_types`, `states`, `screen_level`, `components`) plus the user's description and maybe an app `context` block. No code exists yet for this feature. Do not read the repo: everything you need is in the input. Target 5–15K tokens.

## 1. Pick the states

- Start from `states` and `screen_level`. Drop ones that don't fit what the user described (offline on a static marketing page, pagination on a 3-item list). Merge near-duplicates.
- Add at most 5 states the taxonomy missed but the description implies: timers/expiry, destructive actions, optimistic updates, multi-step flows that can fail halfway, permissions differing by role, anything async the user named. Mark them `source: "added"`.
- Skip default/loaded/hover/focus states unless they need a decision; the AI builds those anyway.

## 2. Prioritise by harm, not frequency

Ask of each: if this state is missing, what happens to the user?
- **must** — they can't finish, lose work, or are told something false (stuck spinner on submit, success shown after failure, expired session that eats a form, no empty state so a blank screen looks broken, no keyboard path to a required control).
- **later** — they're slowed down or it's an edge case (retry button, skeleton polish, very long names).

App context shifts this: `unsaved_work: yes|partly` makes network loss and session expiry `must`; `poor_connectivity_is_normal: yes` makes offline/slow messaging `must`; legal, payment, medical or accessibility `stakes` make keyboard and screen-reader states `must`. If `context` is absent, assume none of these, don't ask, and set `context_assumed: true`.

Aim for 6–12 `must`, and cap `later` at 10.

## 3. One line per state

For each state, `shows`: what the user sees and how they get out, in one line, concrete copy where it matters ("Inline 'Couldn't save — Retry' under the button; form keeps its values"). `component`: an exact name from `components` (or the `ds_hint`); if none fits, `"new: <closest base>"`. `trigger`: when it appears.

## 4. Ready-to-paste prompt

`build_prompt`: a markdown block starting `## States to build` that the user pastes into their build request. Must-haves as a numbered list, one line each: state, what the user sees, component. Then `Later (don't build now):` with names only. End with two rules: "Use only the listed components; name new ones explicitly." and "Every async action needs a loading, success and failure path; failure keeps the user's input." Under 40 lines.

## 5. Output

Return only JSON matching `skill/schema/plan.schema.json`. No prose outside it.
