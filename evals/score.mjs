#!/usr/bin/env node
// Scores a /states run against an answer key. No dependencies.
//
//   node evals/score.mjs <case.json> <findings.json> [--json]   audit mode
//   node evals/score.mjs <plan-case.json> <plan.json> [--json]  plan mode (case.mode === "plan")
//
// Audit findings schema:
//   { findings: [{ title, state_id, consequence, where: [{ file, line }], repro, today }], checked_ok: [...] }
// Plan output schema:
//   { states: [{ id, name, description }] }  (a bare array, or `findings`, is accepted too)

import fs from 'node:fs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const [casePath, runPath] = args.filter((a) => !a.startsWith('--'));
if (!casePath || !runPath) {
  console.error('usage: node evals/score.mjs <case.json> <findings.json|plan.json> [--json]');
  process.exit(2);
}

const kase = JSON.parse(fs.readFileSync(casePath, 'utf8'));
const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));

const norm = (s) => String(s ?? '').toLowerCase().replace(/[“”"'`’]/g, '').replace(/\s+/g, ' ');
const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const kwHits = (text, keywords) => asList(keywords).filter((k) => text.includes(norm(k)));

// A case file entry matches a finding file if one path ends with the other (so a bare
// basename, a folder like "document-signing/", or a full path all work).
function fileMatches(findingFile, caseFile) {
  const f = String(findingFile).replace(/\\/g, '/').replace(/:\d+(-\d+)?$/, '').toLowerCase();
  const c = String(caseFile).replace(/\\/g, '/').toLowerCase();
  if (c.endsWith('/')) return f.includes(c) || f.includes(c.slice(0, -1));
  return f === c || f.endsWith('/' + c) || c.endsWith('/' + f);
}

const findingText = (f) =>
  norm([f.title, f.state_id, f.name, f.repro, f.today, f.why, f.description].filter(Boolean).join(' | '));
const findingFiles = (f) => asList(f.where).map((w) => (typeof w === 'string' ? w : w?.file)).filter(Boolean);

function scoreAudit() {
  const findings = asList(run.findings ?? run);
  const checkedOk = asList(run.checked_ok);
  const expected = asList(kase.expected);

  // Score every (finding, expected) pair. Match = file overlap AND >=1 keyword,
  // or no usable location but >=2 keywords (weak match, flagged).
  const pairs = [];
  findings.forEach((f, fi) => {
    const text = findingText(f);
    const files = findingFiles(f);
    expected.forEach((e, ei) => {
      const hits = kwHits(text, e.match?.keywords);
      const fileOverlap = files.some((ff) => asList(e.match?.files).some((cf) => fileMatches(ff, cf)));
      let score = 0;
      let kind = null;
      if (fileOverlap && hits.length >= 1) { score = 10 + hits.length; kind = 'file+keyword'; }
      else if (hits.length >= 2 && (files.length === 0 || !fileOverlap)) { score = hits.length; kind = 'keyword-only'; }
      // A finding that reads more like a must_not_flag state than this item is not a match.
      const mnfHits = Math.max(0, ...asList(kase.must_not_flag).map((m) => {
        const fo = files.some((ff) => asList(m.files).some((cf) => fileMatches(ff, cf)));
        return fo || files.length === 0 ? kwHits(text, m.keywords).length : 0;
      }));
      if (score > 0 && mnfHits >= hits.length) score = 0;
      if (score > 0) pairs.push({ fi, ei, score, kind, hits });
    });
  });

  // Greedy one-to-one assignment, strongest first.
  pairs.sort((a, b) => b.score - a.score);
  const byExpected = new Map();
  const byFinding = new Map();
  for (const p of pairs) {
    if (byExpected.has(p.ei) || byFinding.has(p.fi)) continue;
    byExpected.set(p.ei, p);
    byFinding.set(p.fi, p);
  }

  // Findings not assigned: duplicate of a matched item, a known recommendation,
  // a must_not_flag violation, or unmatched (needs human review).
  const duplicates = [];
  const recommendations = [];
  const violations = [];
  const unmatched = [];
  findings.forEach((f, fi) => {
    if (byFinding.has(fi)) return;
    const text = findingText(f);
    const files = findingFiles(f);
    const cons = norm(f.consequence);

    const mnf = asList(kase.must_not_flag).find((m) => {
      const hits = kwHits(text, m.keywords);
      const fo = files.some((ff) => asList(m.files).some((cf) => fileMatches(ff, cf)));
      return hits.length > 0 && (fo || files.length === 0);
    });
    if (mnf && cons !== 'recommendation') {
      violations.push({ finding: f.title, state: mnf.state, why_it_is_fine: mnf.why, evidence: mnf.evidence });
      return;
    }
    const dup = pairs.find((p) => p.fi === fi && byExpected.has(p.ei));
    if (dup) { duplicates.push({ finding: f.title, duplicate_of: expected[dup.ei].id }); return; }
    const rec = asList(kase.recommendations).find((r) => kwHits(text, r.keywords).length > 0);
    if (rec || cons === 'recommendation') {
      recommendations.push({ finding: f.title, known: rec?.id ?? null });
      return;
    }
    unmatched.push({ finding: f.title, consequence: f.consequence, where: files, note: 'unmatched — needs human review' });
  });

  // Matched findings that also trip a must_not_flag are fine: the expected item wins.
  const items = expected.map((e, ei) => {
    const p = byExpected.get(ei);
    const f = p ? findings[p.fi] : null;
    const accepted = asList(e.consequence).map(norm);
    return {
      id: e.id,
      must_find: !!e.must_find,
      found: !!p,
      match_kind: p?.kind ?? null,
      finding: f?.title ?? null,
      expected_consequence: e.consequence,
      got_consequence: f?.consequence ?? null,
      consequence_agrees: f ? accepted.includes(norm(f.consequence)) : null,
    };
  });

  const found = items.filter((i) => i.found);
  const must = items.filter((i) => i.must_find);
  const mustFound = must.filter((i) => i.found);
  const agree = found.filter((i) => i.consequence_agrees);
  const scored = found.length + unmatched.length + violations.length;

  // checked_ok: credit for must_not_flag states the run explicitly checked and passed.
  const okText = norm(JSON.stringify(checkedOk));
  const confirmedOk = asList(kase.must_not_flag).filter((m) => kwHits(okText, m.keywords).length > 0).map((m) => m.state);

  return {
    case: kase.name,
    mode: 'audit',
    findings: findings.length,
    recall: { found: found.length, total: items.length, pct: pct(found.length, items.length) },
    recall_must_find: { found: mustFound.length, total: must.length, pct: pct(mustFound.length, must.length) },
    precision: {
      matched: found.length,
      unmatched: unmatched.length,
      violations: violations.length,
      pct_lower_bound: pct(found.length, scored),
      note: 'Unmatched findings count against precision until a human marks them real. Duplicates and recommendations are excluded.',
    },
    consequence_agreement: { agree: agree.length, of: found.length, pct: pct(agree.length, found.length) },
    must_not_flag_violations: violations,
    must_not_flag_confirmed_ok: confirmedOk,
    missed_must_find: must.filter((i) => !i.found).map((i) => i.id),
    missed_optional: items.filter((i) => !i.must_find && !i.found).map((i) => i.id),
    consequence_disagreements: found.filter((i) => !i.consequence_agrees).map((i) => ({ id: i.id, expected: i.expected_consequence, got: i.got_consequence })),
    weak_matches: found.filter((i) => i.match_kind === 'keyword-only').map((i) => i.id),
    duplicates,
    recommendations,
    unmatched,
    items,
  };
}

function scorePlan() {
  const states = run.must || run.later ? [...asList(run.must), ...asList(run.later)] : asList(run.states ?? run.findings ?? run);
  const texts = states.map((s) => norm(typeof s === 'string' ? s : [s.id, s.state_id, s.name, s.title, s.description, s.trigger, s.shows].filter(Boolean).join(' | ')));
  const matchIdx = (keywords) => texts.map((t, i) => (kwHits(t, keywords).length ? i : -1)).filter((i) => i >= 0);

  const hitsById = {};
  for (const e of asList(kase.expected_states)) hitsById[e.id] = matchIdx(e.keywords);

  const items = asList(kase.expected_states).map((e) => {
    let idx = hitsById[e.id];
    let note = null;
    if (e.distinct_from && idx.length) {
      // Needs a state that is not the only one matching the other id.
      const other = hitsById[e.distinct_from] ?? [];
      const distinct = idx.filter((i) => !(other.length === 1 && other[0] === i));
      if (!distinct.length) note = `only matched the same state as ${e.distinct_from}`;
      idx = distinct;
    }
    return { id: e.id, required: e.required !== false, found: idx.length > 0, matched: idx.map((i) => states[i]?.name ?? states[i]?.id ?? states[i]), note };
  });

  const violations = asList(kase.must_not)
    .map((m) => ({ id: m.id, matched: matchIdx(m.keywords).map((i) => states[i]?.name ?? states[i]?.id ?? states[i]) }))
    .filter((v) => v.matched.length);

  const req = items.filter((i) => i.required);
  const reqFound = req.filter((i) => i.found);
  const found = items.filter((i) => i.found);
  return {
    case: kase.name,
    mode: 'plan',
    states_listed: states.length,
    coverage_required: { found: reqFound.length, total: req.length, pct: pct(reqFound.length, req.length) },
    coverage_all: { found: found.length, total: items.length, pct: pct(found.length, items.length) },
    missing_required: req.filter((i) => !i.found).map((i) => (i.note ? `${i.id} (${i.note})` : i.id)),
    must_not_violations: violations,
    items,
  };
}

const result = kase.mode === 'plan' ? scorePlan() : scoreAudit();

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.mode === 'plan') {
  console.log(`${result.case} (plan): ${result.states_listed} states listed`);
  console.log(`  required coverage  ${result.coverage_required.found}/${result.coverage_required.total} (${result.coverage_required.pct}%)`);
  console.log(`  all coverage       ${result.coverage_all.found}/${result.coverage_all.total} (${result.coverage_all.pct}%)`);
  if (result.missing_required.length) console.log(`  missing: ${result.missing_required.join(', ')}`);
  if (result.must_not_violations.length) console.log(`  irrelevant states listed: ${result.must_not_violations.map((v) => v.id).join(', ')}`);
} else {
  const r = result;
  console.log(`${r.case}: ${r.findings} findings`);
  console.log(`  recall (all)        ${r.recall.found}/${r.recall.total} (${r.recall.pct}%)`);
  console.log(`  recall (must_find)  ${r.recall_must_find.found}/${r.recall_must_find.total} (${r.recall_must_find.pct}%)`);
  console.log(`  precision (min)     ${r.precision.matched}/${r.precision.matched + r.precision.unmatched + r.precision.violations} (${r.precision.pct_lower_bound}%)`);
  console.log(`  consequence agrees  ${r.consequence_agreement.agree}/${r.consequence_agreement.of} (${r.consequence_agreement.pct}%)`);
  console.log(`  must_not_flag hits  ${r.must_not_flag_violations.length}`);
  if (r.missed_must_find.length) console.log(`  MISSED must_find: ${r.missed_must_find.join(', ')}`);
  if (r.missed_optional.length) console.log(`  missed optional: ${r.missed_optional.join(', ')}`);
  for (const d of r.consequence_disagreements) console.log(`  consequence: ${d.id} expected ${asList(d.expected).join('|')}, got ${d.got}`);
  for (const v of r.must_not_flag_violations) console.log(`  FALSE ALARM: "${v.finding}" — ${v.state} is handled (${v.evidence})`);
  for (const u of r.unmatched) console.log(`  unmatched — needs human review: "${u.finding}"`);
  if (r.weak_matches.length) console.log(`  keyword-only matches (check): ${r.weak_matches.join(', ')}`);
}

// Non-zero exit when a must-find item is missed or a handled state is flagged, for CI use.
const fail = result.mode === 'plan'
  ? result.missing_required.length > 0
  : result.missed_must_find.length > 0 || result.must_not_flag_violations.length > 0;
process.exit(fail ? 1 : 0);
