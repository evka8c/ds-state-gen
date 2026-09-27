#!/usr/bin/env node

// generate-report.mjs — turns the pipeline's JSON into a visual HTML report + a share card.
// Deterministic, no LLM, runs in well under a second.
//
// Usage:
//   node generate-report.mjs <auditor.json> [inventory.json]
//        [--enumerator enumerator.json]   join state source + cluster (needed for an honest score)
//        [--preclassified pre.json]       states marked Covered without auditing: [{ state_id, evidence }]
//                                         merged in here so the Auditor never has to echo them back
//        [--mockups mockups.json]         before/after mockups for the top fixes, keyed by state_id
//        [--meta meta.json]               { feature, description, ds_name, project_path, summary }
//        [--out report.html]              default: reports/<feature-slug>.html
//        [--no-card]                      skip the share card SVG
//
//   /states input (skill/schema/findings.schema.json):
//   node generate-report.mjs --findings merged.json [inventory.json]
//        [--shots <dir>]                  reads <dir>/shots-before.json and shots-after.json (from
//                                         show-states.mjs); real screenshots replace the mockups.
//                                         Also reads <dir>/verify.json, written after looking
//                                         at the shots: { "<id>": { before_shows_bug,
//                                         after_shows_fix, note } }. Only after_shows_fix:true
//                                         counts as fixed (verified); an after shot without it
//                                         is "fixed in code, not verified".
//        [--fix-notes notes.json]         { "F1": "caveat" } shown under the after frame
//        [--meta meta.json] [--out report.html] [--mockups mockups.json keyed by finding id]
//
//   Or pipe one JSON object to stdin (only when no auditor path is given):
//   { "auditor": {...}, "inventory": {...}, "enumerator": {...}, "mockups": {...}, "meta": {...} }
//
// Status goes to stderr, so stdout never mixes with anything you redirect.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Scoring. Each state the page needs that is missing or half-built costs
// points, by two questions:
//   1. Can the user still finish? (consequence, set by the Auditor)
//        blocker    - no, and refresh/retry doesn't help
//        misleading - yes, but the screen says something false, so they may act wrongly
//        nuisance   - yes, refresh or retry recovers it and nothing is lost
//   2. Will real users hit it? (likelihood, the Enumerator's priority)
//        critical     - yes, in normal use
//        nice-to-have - an edge case
// Half-built costs less than missing. Each finding takes its share of what's
// left, not a flat amount, so a long tail of edge cases can't push a good
// product to zero: score = 100 x product of (1 - points/100).
// States the enumerator merely found in the feature code do not raise the
// score: existing is not the same as needed.
// ---------------------------------------------------------------------------
export const WEIGHTS = {
  consequence: { blocker: 20, misleading: 10, nuisance: 4 }, // a common, fully missing state
  status: { gap: 1, partial: 0.6 },
  likelihood: { critical: 1, 'nice-to-have': 0.3 },
};
const NEEDS_SOURCES = new Set(['taxonomy', 'screen-level']);
const CONSEQUENCES = ['blocker', 'misleading', 'nuisance'];
const CONS_LABEL = { blocker: 'Blocker', misleading: 'Misleading', nuisance: 'Nuisance' };
const CONS_GROUP = {
  blocker: 'Blocks the task',
  misleading: 'Misleads the user',
  nuisance: 'Nuisance: refresh or retry fixes it',
};

// Older audits have no consequence; fall back to the enumerator's likelihood.
function consequenceOf(c) {
  if (c.status !== 'gap' && c.status !== 'partial') return null;
  if (CONSEQUENCES.includes(c.consequence)) return c.consequence;
  return c.priority === 'critical' ? 'misleading' : 'nuisance';
}

function isEdgeCase(c) { return c.priority === 'nice-to-have'; }

// Share of the score this finding takes, in points out of 100.
function deduction(c) {
  const k = consequenceOf(c);
  if (!k) return 0;
  return WEIGHTS.consequence[k] * WEIGHTS.status[c.status] * (WEIGHTS.likelihood[c.priority] ?? 1);
}

function scoreOf(findings) {
  return 100 * findings.reduce((s, c) => s * (1 - deduction(c) / 100), 1);
}

function consBadge(c) {
  const k = consequenceOf(c);
  return k ? `<span class="cons cons-${k}">${CONS_LABEL[k]}</span>${isEdgeCase(c) ? ' <span class="cons cons-edge">Edge case</span>' : ''}` : '';
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function readJson(p) { return JSON.parse(readFileSync(resolve(p), 'utf8')); }

function flag(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function loadInput() {
  const positional = [];
  const valueFlags = new Set(['--enumerator', '--preclassified', '--mockups', '--meta', '--out', '--tier2', '--findings', '--shots', '--fix-notes']);
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    positional.push(a);
  }

  let data;
  if (flag('--findings')) {
    // /states path: findings replace auditor + enumerator; the one positional is the inventory.
    const findings = readJson(flag('--findings'));
    data = { auditor: { coverage: findingsToCoverage(findings) }, inventory: positional[0] ? readJson(positional[0]) : null };
    data.meta = { description: findings.feature_summary || '' };
    if (flag('--shots')) data.shots = loadShots(flag('--shots'));
    if (flag('--fix-notes')) data.fixNotes = readJson(flag('--fix-notes'));
  } else if (positional.length) {
    data = { auditor: readJson(positional[0]), inventory: positional[1] ? readJson(positional[1]) : null };
  } else if (!process.stdin.isTTY) {
    const raw = readFileSync(0, 'utf8');
    if (!raw.trim()) throw new Error('No input: pass <auditor.json> or pipe JSON to stdin.');
    data = JSON.parse(raw);
  } else {
    throw new Error('Usage: node generate-report.mjs <auditor.json> [inventory.json] [--enumerator f] [--mockups f] [--meta f] [--out f]');
  }

  if (flag('--enumerator')) data.enumerator = readJson(flag('--enumerator'));
  if (flag('--preclassified')) data.preclassified = readJson(flag('--preclassified'));
  if (flag('--mockups')) data.mockups = readJson(flag('--mockups'));
  if (flag('--meta')) data.meta = { ...(data.meta || {}), ...readJson(flag('--meta')) };
  if (flag('--out')) data.meta = { ...(data.meta || {}), output: flag('--out') };
  if (flag('--tier2')) data.tier2 = flag('--tier2').split(',').map(Number);
  data.card = !process.argv.includes('--no-card');
  return data;
}

// /states findings -> the report's internal state list. Every finding is a state
// the page needs; checked_ok states count as designed.
function findingsToCoverage(f) {
  const where = (w) => (w || []).map((x) => `${x.file}:${x.line}`).join(', ');
  const out = (f.findings || []).map((x) => ({
    state_id: x.id,
    name: x.title,
    status: x.consequence === 'recommendation' ? 'recommendation' : 'gap',
    consequence: x.consequence === 'recommendation' ? undefined : x.consequence,
    consequence_reason: x.consequence_reason,
    priority: 'critical',
    required: x.consequence === 'blocker',
    component: x.state_id || x.kind,
    description: x.today,
    repro: x.repro,
    verdict: x.verdict,
    evidence: where(x.where),
    gap_label: x.fix?.summary,
    behaviour: x.fix?.behaviour,
    extends_from: x.fix?.components || [],
    implementation: [x.repro && `Repro: ${x.repro}`, x.fix?.behaviour && `After the fix: ${x.fix.behaviour}`, x.also_covers?.length && `Also covers: ${x.also_covers.join(', ')}`].filter(Boolean),
  }));
  for (const ok of f.checked_ok || []) {
    out.push({ state_id: ok.state_id, name: ok.state_id, status: 'covered', evidence: ok.evidence, component: ok.state_id.split('.')[0] });
  }
  return out;
}

// shots-<label>.json from show-states.mjs, with each ok PNG inlined as a data URI.
function loadShots(dir) {
  const shots = { before: {}, after: {} };
  for (const label of ['before', 'after']) {
    const p = join(resolve(dir), `shots-${label}.json`);
    if (!existsSync(p)) continue;
    for (const [id, r] of Object.entries(readJson(p))) {
      const file = r.ok && r.file && join(resolve(dir), r.file);
      if (file && existsSync(file)) shots[label][id] = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
    }
  }
  const v = join(resolve(dir), 'verify.json');
  shots.verify = existsSync(v) ? readJson(v) : null;
  return shots;
}

// Screenshots are embedded once (SHOTS map in the page script) and referenced by key.
function shotImg(id, label, alt) {
  return `<img data-shot="${esc(id)}|${label}" alt="${esc(alt)}">`;
}
function shotFrame(id, label, alt) {
  return `<button type="button" class="shot" data-open="${esc(id)}|${label}" aria-label="Enlarge: ${esc(alt)}">${shotImg(id, label, alt)}</button>`;
}

// Numeric ids sort numerically; finding ids (F1, F10) by their number.
function idOrder(a, b) {
  const n = (x) => (typeof x === 'number' ? x : Number(String(x).replace(/^\D+/, '')));
  const d = n(a.state_id) - n(b.state_id);
  return Number.isNaN(d) ? String(a.state_id).localeCompare(String(b.state_id)) : d;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function slug(s) { return String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

const STATUS_LABEL = { fixed: 'Fixed, verified on screen', fixedcode: 'Fixed in code, not verified', covered: 'Designed', partial: 'Half-built', gap: 'No design', recommendation: 'Optional' };

function badge(status) {
  const cls = { fixed: 'badge-fixed', fixedcode: 'badge-rec', covered: 'badge-covered', partial: 'badge-partial', gap: 'badge-gap', recommendation: 'badge-rec' }[status] || 'badge-gap';
  return `<span class="badge ${cls}">${STATUS_LABEL[status] || status}</span>`;
}

// Fixed findings never carry their old status badge.
function statusBadge(c) { return badge(c.fixed ? 'fixed' : c.fixState === 'code' ? 'fixedcode' : c.status); }

// What is missing, in a few words, for a tile caption.
function missingText(c) {
  const ev = String(c.evidence || '');
  const m = ev.match(/missing:\s*([^.;]+)/i);
  if (c.status === 'partial' && m) return 'Missing: ' + trunc(m[1].trim(), 60);
  const label = String(c.gap_label || c.notes || '');
  return trunc(label.replace(/^(Reuse|Extend|New)\s+/i, (x) => x), 64);
}

// ---------------------------------------------------------------------------
// Palette: read the project's own tokens so thumbnails and mockups look like
// the product, not like this report.
// ---------------------------------------------------------------------------
function cssColor(value) {
  const v = String(value || '');
  // A colour built from other variables can't be drawn here; let the caller try the next token.
  if (/var\(|calc\(|\bfrom\b/.test(v.split(' / ')[0])) return null;
  const hex = v.match(/#[0-9a-fA-F]{3,8}\b/);
  if (hex) return hex[0];
  const fn = v.match(/\b(?:rgba?|hsla?|oklch|lab)\([^)]*\)/);
  if (fn) return fn[0];
  const hslTriplet = v.match(/^\s*(-?\d+(?:\.\d+)?)(?:deg)?\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
  if (hslTriplet) return `hsl(${hslTriplet[1]} ${hslTriplet[2]}% ${hslTriplet[3]}%)`;
  return null;
}

function pickColor(colors, patterns) {
  for (const re of patterns) {
    for (const t of colors) {
      if (!re.test(t.name || '')) continue;
      const v = cssColor(t.value);
      if (v) return v;
    }
  }
  return null;
}

function palette(inventory) {
  const colors = inventory?.tokens?.colors || [];
  // Script inventories give token lists; hand-written ones may give a summary string or object.
  const list = (v) => (Array.isArray(v) ? v : []);
  const radii = list(inventory?.tokens?.radii);
  const typoRaw = inventory?.tokens?.typography;
  const typo = Array.isArray(typoRaw) ? typoRaw : typoRaw?.font_family ? [{ name: 'font-family', value: typoRaw.font_family }] : [];
  const p = {
    primary: pickColor(colors, [/^--primary$/, /^--(color-)?(primary|brand|accent)(-500|-default)?$/i, /primary|brand/i]) || '#3b6fe0',
    'primary-fg': pickColor(colors, [/^--primary-foreground$/, /(primary|brand).*(fg|foreground|on|text)/i]) || '#ffffff',
    destructive: pickColor(colors, [/^--destructive$/, /(destructive|danger|error|critical)(-500|-default)?$/i, /destructive|danger|error/i]) || '#d93025',
    'destructive-fg': pickColor(colors, [/^--destructive-foreground$/, /(destructive|danger|error).*(fg|foreground|on|text)/i]) || '#ffffff',
    warning: pickColor(colors, [/^--warning$/, /(warning|caution)(-500|-default)?$/i, /warning|caution/i]) || '#e5a100',
    border: pickColor(colors, [/^--border$/, /border(-default)?$/i, /border/i]) || '#e5e5e5',
    muted: pickColor(colors, [/^--muted$/, /(muted|subtle|surface-2|bg-subtle)$/i, /muted|subtle/i]) || '#f1f1f1',
    'muted-fg': pickColor(colors, [/^--muted-foreground$/, /(muted|secondary|subtle).*(fg|foreground|text)/i, /text-(muted|secondary)/i]) || '#6b6b6b',
    bg: pickColor(colors, [/^--background$/, /^--(color-)?(bg|background|surface)(-default|-base)?$/i]) || '#ffffff',
    fg: pickColor(colors, [/^--foreground$/, /^--(color-)?(fg|foreground|text)(-default|-primary)?$/i]) || '#1a1a1a',
    ring: pickColor(colors, [/^--ring$/, /focus|ring/i]) || null,
  };
  p.ring = p.ring || p.primary;
  const r = radii.map((t) => String(t.value || '').match(/^\s*(\d*\.?\d+)(rem|px)\b/)).find(Boolean);
  p.radius = r ? r[0].trim() : '6px';
  const font = typo.find((t) => /font-(sans|body|family)|family/i.test(t.name || ''));
  const fam = font && String(font.value || '').match(/["']?([A-Z][A-Za-z0-9 ]+?)["']?(?:\s*\(|,|$)/);
  p.font = fam ? `'${fam[1].trim()}', system-ui, sans-serif` : 'system-ui, sans-serif';
  return p;
}

function paletteCss(p) {
  const radiusMini = /rem$/.test(p.radius) ? `${Math.min(parseFloat(p.radius) * 16 * 0.4, 6).toFixed(1)}px` : `${Math.min(parseFloat(p.radius) * 0.4, 6).toFixed(1)}px`;
  return `.mock, .mini {
  --m-primary: ${p.primary}; --m-primary-fg: ${p['primary-fg']};
  --m-destructive: ${p.destructive}; --m-destructive-fg: ${p['destructive-fg']};
  --m-warning: ${p.warning}; --m-border: ${p.border}; --m-muted: ${p.muted}; --m-muted-fg: ${p['muted-fg']};
  --m-bg: ${p.bg}; --m-fg: ${p.fg}; --m-ring: ${p.ring};
  --m-radius: ${p.radius}; --m-radius-mini: ${radiusMini}; --m-font: ${p.font};
}`;
}

// ---------------------------------------------------------------------------
// Thumbnails. Each state gets a tiny schematic of what the screen looks like
// in that state, drawn from the project's tokens. The kind is inferred from
// the state's name and description, so it works on any repo.
// ---------------------------------------------------------------------------
function kindOf(c) {
  const name = String(c.name || '').toLowerCase();
  const text = `${name} ${String(c.component || '').toLowerCase()} ${String(c.description || '').toLowerCase().slice(0, 160)}`;
  const n = (re) => re.test(name);
  if (n(/offline/)) return 'offline';
  if (n(/keyboard/)) return 'keyboard';
  if (n(/screen reader/)) return 'reader';
  if (n(/reduced motion|motion/)) return 'motion';
  if (n(/contrast/)) return 'contrast';
  if (n(/print/)) return 'print';
  if (n(/responsive|mobile|breakpoint/)) return 'phone';
  if (n(/slow|loading|processing|applying|submitting|inserting|removing|requesting|redirect|completing/)) return 'loading';
  if (/toast/.test(text) && /error|fail|invalid|not allowed/.test(text)) return 'toast-error';
  if (/toast/.test(text)) return 'toast';
  if (n(/error|invalid|failed|too small|too large|wrong|violated|unavailable|rejected\b|expired code|code expired/)) return /form|input|pin|code|password/.test(text) ? 'form-error' : 'error';
  if (n(/expired|cancelled|not found|blocked|waiting|signed|everyone|rejected|complete page|terminal/) || /\bpage\b/.test(String(c.component || '').toLowerCase())) return 'page';
  if (/signature|pad|draw/.test(text)) return 'pad';
  if (/dialog|modal|confirm|picker|popover/.test(text)) return 'dialog';
  if (n(/empty|no results|none/)) return 'empty';
  if (/form|input|pin|password|code/.test(text)) return 'form';
  return 'screen';
}

const DOC = '<div class="bar"></div><div class="doc"><i></i><i></i><i style="width:60%"></i><i></i><i style="width:40%"></i></div><div class="side"><b></b><b style="width:70%"></b><b class="p"></b></div>';

function mini(kind) {
  switch (kind) {
    case 'loading': return '<div class="bar"></div><div class="spin"></div>';
    case 'offline': return DOC + '<div class="banner"></div>';
    case 'error': return '<div class="bar"></div><div class="erricon"></div><div class="errtext"></div>';
    case 'toast': return DOC + '<div class="toast"></div>';
    case 'toast-error': return DOC + '<div class="toast err"></div>';
    case 'page': return '<div class="pagecard"></div>';
    case 'dialog': return DOC + '<div class="dim"></div><div class="dlg"></div>';
    case 'pad': return DOC + '<div class="dim"></div><div class="dlg"><div class="pad"></div></div>';
    case 'form': return '<div class="inp a"></div><div class="inp b"></div><div class="btnp"></div>';
    case 'form-error': return '<div class="inp a"></div><div class="inp b err"></div><div class="btnp" style="opacity:.5"></div>';
    case 'empty': return '<div class="bar"></div><div class="empty"></div>';
    case 'keyboard': return DOC + '<div class="fld ring"></div><div class="key">Tab</div>';
    case 'reader': return DOC + '<div class="bubble"></div>';
    case 'motion': return '<div class="bar"></div><div class="streaks"></div>';
    case 'contrast': return '<div class="bar" style="border-color:#fff"></div><div class="doc"><i></i><i></i><i style="width:60%"></i></div>';
    case 'print': return '<div class="sheet"><i></i><i></i><i style="width:60%"></i><i></i></div>';
    case 'phone': return '<div class="phone"><i></i><i></i><i style="width:60%"></i><i></i></div>';
    default: return DOC + '<div class="fld"></div>';
  }
}

function tile(c, shots) {
  const kind = kindOf(c);
  const before = shots?.before?.[c.state_id];
  const done = c.fixed || c.fixState === 'code';
  if (done || before) {
    // Real screenshot: the fixed state if there is one, else today. Click compares both.
    const label = done ? 'after' : 'before';
    const k = consequenceOf(c);
    return `<a class="tile tile-shot ${done ? 'tile-fixed' : `tile-${c.status}`}" href="#state-${c.state_id}" data-compare="${esc(c.state_id)}" title="Click to compare today and after the fix">
  <div class="tile-frame">${shotImg(c.state_id, label, `${done ? 'After fix' : 'Today'}: ${c.name}`)}<span class="tile-flag">${c.fixed ? 'Fixed' : done ? 'Fixed in code' : { gap: 'No design', partial: 'Half-built', recommendation: 'Optional' }[c.status] || ''}</span></div>
  <div class="tile-name">${esc(c.name)}</div><div class="tile-miss">${k ? `<span class="cons cons-${k}">${CONS_LABEL[k]}</span> ` : ''}${done ? 'Was: ' : ''}${esc(trunc(c.consequence_reason || missingText(c), 80))}</div>
</a>`;
  }
  const cls = `tile tile-${c.status}`;
  const flagText = { gap: 'No design', partial: 'Half-built', recommendation: 'Optional' }[c.status];
  const empty = c.status === 'gap' ? '<div class="tile-empty">Nothing designed here</div>' : '';
  const k = consequenceOf(c);
  const sub = c.status === 'covered' ? '' : `<div class="tile-miss">${k ? `<span class="cons cons-${k}">${CONS_LABEL[k]}</span> ` : ''}${esc(trunc(c.consequence_reason || missingText(c), 90))}</div>`;
  return `<a class="${cls}" href="#state-${c.state_id}" title="${esc(c.description || c.name)}">
  <div class="tile-frame"><div class="mini${kind === 'contrast' ? ' hc' : ''}">${mini(kind)}</div>${flagText ? `<span class="tile-flag">${flagText}</span>` : ''}${empty}</div>
  <div class="tile-name">${esc(c.name)}</div>${sub}
</a>`;
}

// ---------------------------------------------------------------------------
// Fix prompt: what a designer pastes into their coding agent.
// ---------------------------------------------------------------------------
function fixPrompt(c, meta) {
  const from = (c.extends_from || []).join('; ');
  return [
    `In ${meta.project_label || 'this project'}, the "${meta.feature}" has a UI state that isn't fully designed: ${c.name}.`,
    c.description ? `What happens today: ${c.description}` : '',
    c.evidence ? `Evidence: ${c.evidence}` : '',
    c.repro ? `To reproduce: ${c.repro}` : '',
    c.gap_label ? `What's needed: ${c.gap_label}.` : '',
    from ? `Build it from what the design system already has: ${from}.` : '',
    'Use existing tokens and components only. Cover loading, error and focus behaviour, and give anything announced to screen readers a role or aria-live.',
    'Show me the change before writing it.',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
function heroSection(ctx) {
  const { score, lifted, counts, cons, needsCount, meta, fixedCount, afterScore, codeFixedCount } = ctx;
  const codeLine = codeFixedCount ? ` ${plural(codeFixedCount, 'more is', 'more are')} fixed in code but not verified on screen, and not counted.` : '';
  const cx = meta.context || {};
  const ctxBits = [cx.unsaved_work && `unsaved work: ${cx.unsaved_work}`, cx.poor_connectivity_is_normal && `poor connectivity normal: ${cx.poor_connectivity_is_normal}`, cx.stakes && `stakes: ${cx.stakes}`].filter(Boolean);
  const ctxLine = ctxBits.length ? ` App context: ${ctxBits.join('; ')}.` : '';
  const band = score < 50 ? 'gap' : score < 75 ? 'partial' : 'covered';
  const color = `var(--status-${band})`;
  const summary = meta.summary
    ? `<p class="summary-text">${esc(meta.summary)}</p><p class="ai-label">Summary written by AI from the measured findings below.</p>`
    : `<p class="summary-text">${esc(autoSummary(ctx))}</p>`;
  return `<div class="hero">
  <div class="card score-card score-band-${band}">
    <div class="eyebrow">State coverage</div>
    <div class="score"><span class="score-value">${score}</span><span class="score-max">/100</span>${fixedCount ? `<span class="score-after">&rarr; ${afterScore}</span>` : ''}</div>
    <div class="score-bar" style="color:${color}"><div class="score-bar-now" style="width:${score}%"></div>${fixedCount && afterScore > score ? `<div class="score-bar-lift" style="left:${score}%;width:${afterScore - score}%"></div>` : lifted > score ? `<div class="score-bar-lift" style="left:${score}%;width:${lifted - score}%"></div>` : ''}</div>
    <div class="score-lift">${fixedCount ? `<strong>${score} &rarr; ${afterScore} after fixes.</strong> ${plural(fixedCount, 'fix', 'fixes')} verified on screen.${codeLine}` : ctx.fixes.length ? `<strong>${plural(ctx.fixes.length, 'fix', 'fixes')} lift it to ${lifted}.</strong>${codeLine}` : `<strong>Nothing left to fix.</strong>${codeLine}`}</div>
    <div class="counts">
      <div class="count count-blocker"><div class="count-value">${cons.blocker}</div><div class="count-label">Blockers</div></div>
      <div class="count count-misleading"><div class="count-value">${cons.misleading}</div><div class="count-label">Misleading</div></div>
      <div class="count count-nuisance"><div class="count-value">${cons.nuisance}</div><div class="count-label">Nuisances</div></div>
      <div class="count count-covered"><div class="count-value">${counts.covered}</div><div class="count-label">Designed</div></div>
    </div>
    <p class="score-how"><strong>How points come off:</strong> each finding takes a share of what's left: a blocker ${WEIGHTS.consequence.blocker}, misleading ${WEIGHTS.consequence.misleading}, a nuisance ${WEIGHTS.consequence.nuisance} points if fully missing; half-built costs ${WEIGHTS.status.partial * 100}% of that, and an edge case ${WEIGHTS.likelihood['nice-to-have'] * 100}%.</p>
    <p class="score-how">Scored on the ${needsCount} states this page needs, by whether the user can still finish and how many people will hit it. A common blocker takes ${WEIGHTS.consequence.blocker}% of the score, misleading ${WEIGHTS.consequence.misleading}%, a nuisance ${WEIGHTS.consequence.nuisance}%. Half-built counts ${WEIGHTS.status.partial * 100}%, an edge case ${WEIGHTS.likelihood['nice-to-have'] * 100}%.${ctxLine}</p>
  </div>
  <div class="card summary-card">
    <div class="eyebrow">Summary</div>
    ${summary}
  </div>
</div>`;
}

function autoSummary({ counts, cons, needsCount, fixes, score, lifted }) {
  const parts = [`This page needs ${needsCount} states.`];
  if (cons.blocker) parts.push(`${plural(cons.blocker, 'stops', 'stop')} someone finishing the task.`.replace(/^(\d+) stops/, '$1 stops'));
  if (counts.gap || counts.partial) {
    parts.push(`${counts.gap} ${counts.gap === 1 ? 'has' : 'have'} no design and ${counts.partial} ${counts.partial === 1 ? 'is' : 'are'} half-built.`);
  } else {
    parts.push('Every one of them is designed.');
  }
  if (fixes[0]) parts.push(`The costliest is ${fixes[0].name.toLowerCase()}.`);
  if (fixes.length) parts.push(`${plural(fixes.length, 'fix', 'fixes')} take the score from ${score} to ${lifted}.`);
  return parts.join(' ');
}

// Today / After fix (or Proposed) pair from real screenshots; null when there is no before shot.
function compareShots(c, shots, notes, m) {
  const before = shots?.before?.[c.state_id];
  if (!before && !c.noRepro) return null;
  const after = shots?.after?.[c.state_id];
  const note = notes?.[c.state_id] || c.verifyNote;
  const today = before ? shotFrame(c.state_id, 'before', `Today: ${c.name}`) : `<div class="mock mock-text"><p>Couldn't reproduce this on screen; the finding rests on the code.</p>${typeof c.noRepro === 'string' ? `<p class="mock-text-sub">${esc(c.noRepro)}</p>` : ''}</div>`;
  const afterCap = c.fixed ? 'After fix, verified' : 'After fix, not verified';
  return `<div class="compare compare-shots">
      <figure class="compare-col compare-today"><figcaption>Today</figcaption>${today}${c.description ? `<p class="compare-note">${esc(c.description)}</p>` : ''}</figure>
      ${after
        ? `<figure class="compare-col compare-proposed"><figcaption>${afterCap}</figcaption>${shotFrame(c.state_id, 'after', `After fix: ${c.name}`)}${c.behaviour || c.gap_label ? `<p class="compare-note">${esc(c.behaviour || c.gap_label)}</p>` : ''}${note ? `<p class="compare-caveat"><strong>Note:</strong> ${esc(note)}</p>` : ''}</figure>`
        : `<figure class="compare-col compare-proposed"><figcaption>Proposed</figcaption>${m?.proposed ? `<div class="mock">${m.proposed}</div>` : `<div class="mock mock-text"><p>${esc(c.gap_label || '')}</p>${c.behaviour ? `<p class="mock-text-sub">${esc(c.behaviour)}</p>` : ''}</div>`}${m?.proposed_caption ? `<p class="compare-note">${esc(m.proposed_caption)}</p>` : ''}</figure>`}
    </div>`;
}

// Every finding with screenshots, not just the top 3.
function allFixesSection(ctx) {
  const { needs, shots } = ctx;
  const list = needs.filter((c) => shots?.before?.[c.state_id] || (c.noRepro && shots?.after?.[c.state_id])).sort((a, b) => deduction(b) - deduction(a) || idOrder(a, b));
  if (!list.length) return '';
  const items = list.map((c) => `<article class="fix fix-compact" id="shots-${esc(c.state_id)}">
    <div class="fix-title">${esc(c.name)} ${consBadge(c)} ${statusBadge(c)}</div>
    ${c.repro ? `<p class="fix-repro"><strong>Repro:</strong> ${esc(c.repro)}</p>` : ''}
    ${compareShots(c, shots, ctx.fixNotes, ctx.mockups?.[String(c.state_id)])}
  </article>`).join('\n');
  return `<section class="section" id="all-fixes">
  <div class="section-head"><h2>All fixes</h2><p>Every finding, captured in a real browser. Click a screenshot to enlarge it.</p></div>
  ${items}
</section>`;
}

function fixesSection(ctx) {
  const { fixes, mockups, meta, shots } = ctx;
  if (!fixes.length) return '';
  const items = fixes.map((c, i) => {
    const m = mockups?.[String(c.state_id)];
    const shotCompare = compareShots(c, shots, ctx.fixNotes, m);
    const compare = shotCompare ? shotCompare : m ? `<div class="compare">
      <figure class="compare-col compare-today"><figcaption>Today</figcaption><div class="mock">${m.today}</div>${m.today_caption ? `<p class="compare-note">${esc(m.today_caption)}</p>` : ''}</figure>
      <figure class="compare-col compare-proposed"><figcaption>Proposed</figcaption><div class="mock">${m.proposed}</div>${m.proposed_caption ? `<p class="compare-note">${esc(m.proposed_caption)}</p>` : ''}</figure>
    </div>` : '';
    return `<article class="fix">
    <div class="fix-head"><span class="fix-num">0${i + 1}</span><div>
      <div class="fix-title">${esc(c.name)} ${consBadge(c)} ${statusBadge(c)} <span class="fix-points">+${c.gain}</span></div>
      ${c.consequence_reason ? `<p class="fix-why">${esc(c.consequence_reason)}</p>` : `<p class="fix-body">${esc(c.description || '')}</p>`}
      <div class="fix-actions"><button class="copy-btn" type="button" data-prompt="${esc(fixPrompt(c, meta))}">Copy the fix prompt</button><span>${esc(c.gap_label || '')}</span><a href="#state-${c.state_id}">Evidence</a></div>
    </div></div>
    ${compare}
  </article>`;
  }).join('\n');
  return `<section class="section" id="fixes">
  <div class="section-head"><h2>Where to start</h2><p>Ranked by how many points each fix is worth.</p></div>
  ${items}
</section>`;
}

function stripSection(ctx) {
  const { needs } = ctx;
  const groups = [
    { key: 'fixed', name: 'Fixed, verified on screen', list: needs.filter((c) => c.fixed) },
    { key: 'fixed', name: 'Fixed in code, not verified on screen', list: needs.filter((c) => c.fixState === 'code') },
    ...CONSEQUENCES.map((k) => ({ key: k, name: CONS_GROUP[k], list: needs.filter((c) => !c.fixState && consequenceOf(c) === k) })),
    { key: 'recommendation', name: 'Optional', list: needs.filter((c) => c.status === 'recommendation') },
    { key: 'covered', name: 'Designed', list: needs.filter((c) => c.status === 'covered') },
  ].filter((g) => g.list.length);
  const html = groups.map(({ key, name, list }) => {
    list.sort((a, b) => deduction(b) - deduction(a) || idOrder(a, b));
    return `<div class="strip-group strip-${key}"><div class="strip-group-title"><span class="pill pill-${key}">${list.length}</span> ${esc(name)}</div><div class="strip">${list.map((c) => tile(c, ctx.shots)).join('\n')}</div></div>`;
  }).join('\n');
  return `<section class="section" id="states">
  <div class="section-head"><h2>Every state this page needs</h2><p>Drawn with the project's own tokens. Dashed frames have no design. Click one for the evidence.</p></div>
  ${html}
</section>`;
}

function matrixRow(c, tier2) {
  const expandable = c.status !== 'covered';
  const rowAttrs = expandable ? ` class="expandable" onclick="toggleDetail(this)"` : '';
  let html = `<tr id="state-${c.state_id}"${rowAttrs}>
  <td><div class="state-name">${esc(c.name)}</div><div class="state-component">${esc(c.component || 'screen-level')}</div></td>
  <td class="state-description">${esc(c.description || '')}</td>
  <td class="req-cell">${c.required ? '<span class="badge badge-required">Required</span>' : ''}</td>
  <td>${statusBadge(c)}${consBadge(c) ? `<div style="margin-top:4px">${consBadge(c)}</div>` : ''}</td>
  <td class="file-ref">${c.verdict ? `<span class="badge ${/^confirmed$/i.test(c.verdict) ? 'badge-covered' : 'badge-partial'}">${esc(String(c.verdict).toUpperCase())}</span> ` : ''}${esc(c.evidence || '')}</td>
</tr>\n`;
  if (expandable) {
    const from = (c.extends_from || []).map((e) => `<li><code>${esc(e)}</code></li>`).join('');
    const impl = (c.implementation || []).map((e) => `<li>${esc(e)}</li>`).join('');
    const notes = c.notes ? `<p>${esc(c.notes)}</p>` : '';
    const groups = [
      from ? `<div class="note-group"><h4>Build from</h4><ul>${from}</ul></div>` : '',
      impl || notes ? `<div class="note-group"><h4>Notes</h4>${impl ? `<ul>${impl}</ul>` : ''}${notes}</div>` : '',
    ].filter(Boolean).join('');
    const t2 = c.tier2_html && (!tier2.length || tier2.includes(c.state_id)) ? c.tier2_html : '';
    html += `<tr class="state-detail"><td colspan="5">
  <div class="suggestion suggestion-${c.status}">${consequenceOf(c) ? `<strong>${CONS_LABEL[consequenceOf(c)]}.</strong> ${esc(c.consequence_reason || '')}<br>` : ''}<strong>Fix:</strong> ${esc(c.gap_label || '')}</div>
  ${t2}
  ${groups ? `<div class="detail-notes">${groups}</div>` : ''}
</td></tr>\n`;
  }
  return html;
}

function matrixSection(ctx) {
  const { needs, exists, clusterOf, tier2 } = ctx;
  const order = ['gap', 'partial', 'fixedcode', 'fixed', 'recommendation', 'covered'];
  const titles = { gap: 'No design', partial: 'Half-built', fixedcode: 'Fixed in code, not verified', fixed: 'Fixed, verified on screen', recommendation: 'Optional', covered: 'Designed' };
  const dividers = { gap: 'gap', partial: 'partial', fixedcode: 'rec', fixed: 'covered', recommendation: 'rec', covered: 'covered' };
  const statusOf = (c) => (c.fixed ? 'fixed' : c.fixState === 'code' ? 'fixedcode' : c.status);
  let rows = '';
  for (const s of order) {
    const list = needs.filter((c) => statusOf(c) === s).sort((a, b) => deduction(b) - deduction(a) || idOrder(a, b));
    if (!list.length) continue;
    rows += `<tr><td colspan="5" class="section-divider section-divider-${dividers[s]}">${titles[s]} (${list.length})</td></tr>\n`;
    rows += list.map((c) => matrixRow(c, tier2)).join('');
  }
  let existsHtml = '';
  if (exists.length) {
    const byCluster = new Map();
    for (const c of exists) {
      const g = clusterOf(c) || 'Other';
      if (!byCluster.has(g)) byCluster.set(g, []);
      byCluster.get(g).push(c);
    }
    existsHtml = `<details class="exists"><summary>What already exists: ${exists.length} states found in the feature code</summary>
  <p class="exists-note">The enumerator discovered these by reading the feature. They are shown for context and do not count toward the score, because a state existing in code is not proof that it is designed well.</p>
  ${[...byCluster.entries()].map(([g, list]) => `<div class="exists-group"><h4>${esc(g)}</h4><div class="chips">${list.map((c) => `<span class="chip" title="${esc(c.description || '')}">${esc(c.name)}</span>`).join('')}</div></div>`).join('')}
</details>`;
  }
  return `<section class="section" id="evidence">
  <div class="section-head"><h2>Evidence</h2><p>Every judgement cites a file and line. Click a row to expand.</p></div>
  <div class="matrix-wrap"><table class="matrix">
    <colgroup><col style="width:20%"><col style="width:24%"><col style="width:10%"><col style="width:11%"><col style="width:35%"></colgroup>
    <thead><tr><th>State</th><th>Description</th><th>Required</th><th>Status</th><th>Evidence</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>
  ${existsHtml}
</section>`;
}

// ---------------------------------------------------------------------------
// Share card (1200x630 SVG, light)
// ---------------------------------------------------------------------------
function xml(s) { return esc(s).replace(/'/g, '&apos;'); }

function shareCard(ctx) {
  const { score, lifted, fixes, meta, date } = ctx;
  const band = score < 50 ? '#c0392b' : score < 75 ? '#a86f00' : '#2a7d4f';
  const worst = ctx.needs.filter((c) => deduction(c) > 0)
    .sort((a, b) => deduction(b) - deduction(a) || idOrder(a, b)).slice(0, 3);
  const rows = worst.map((c, i) => {
    const y = 250 + i * 88;
    const col = { blocker: '#b42318', misleading: '#c4620a', nuisance: '#7a8595' }[consequenceOf(c)];
    return `<circle cx="652" cy="${y - 8}" r="8" fill="${col}"/>
  <text x="676" y="${y}" font-size="26" font-weight="650" fill="#18181b">${xml(trunc(c.name, 30))}</text>
  <text x="676" y="${y + 34}" font-size="21" fill="#6b6b72">${CONS_LABEL[consequenceOf(c)]} · ${c.status === 'gap' ? 'no design' : 'half-built'}</text>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter, -apple-system, 'Segoe UI', system-ui, sans-serif">
  <rect width="1200" height="630" fill="#f6f6f3"/>
  <rect x="40" y="40" width="1120" height="550" rx="28" fill="#ffffff" stroke="#e4e4e0" stroke-width="2"/>
  <text x="96" y="118" font-size="24" font-weight="600" fill="#18181b">${xml(trunc(meta.feature, 40))}</text>
  <text x="96" y="152" font-size="19" fill="#95959c" font-family="ui-monospace, Menlo, monospace">${xml(trunc(meta.project_label || '', 48))}</text>
  <text x="1104" y="118" font-size="17" font-weight="600" fill="#95959c" text-anchor="end" letter-spacing="2">UI STATE COVERAGE</text>
  <text x="90" y="392" font-size="210" font-weight="700" fill="${band}" letter-spacing="-8">${score}</text>
  <text x="${score >= 100 ? 470 : 340}" y="392" font-size="46" font-weight="500" fill="#95959c">/100</text>
  <text x="96" y="446" font-size="23" fill="#5f5f66">${fixes.length ? `${plural(fixes.length, 'fix', 'fixes')} lift it to ${lifted}` : 'every state designed'}</text>
  <line x1="600" y1="200" x2="600" y2="470" stroke="#e4e4e0" stroke-width="2"/>
  <text x="640" y="196" font-size="17" font-weight="600" fill="#95959c" letter-spacing="2">${worst.length ? 'WORST FIRST' : ''}</text>
  ${rows}
  <line x1="96" y1="510" x2="1104" y2="510" stroke="#efefec" stroke-width="2"/>
  <text x="96" y="552" font-size="20" fill="#5f5f66" font-family="ui-monospace, Menlo, monospace">ds-state-gen</text>
  <text x="1104" y="552" font-size="18" fill="#95959c" text-anchor="end">${xml(date)}</text>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function build(data) {
  const { auditor, inventory, enumerator, mockups = {}, tier2 = [] } = data;
  const meta = { ...(data.meta || {}) };
  meta.feature = meta.feature || enumerator?.feature?.name || 'Feature';
  meta.description = meta.description || enumerator?.feature?.description || '';
  meta.ds_name = meta.ds_name || inventory?.project?.ds_name || inventory?.ds_name || inventory?.project?.name || inventory?.name || '';
  meta.project_label = meta.project_path || inventory?.project?.name || '';

  const enumById = new Map((enumerator?.states || []).map((s) => [s.id, s]));
  // Pre-classified states come from the orchestrator, not the Auditor. The
  // Auditor's verdict wins if it audited the same state anyway.
  const audited = auditor.coverage || [];
  const auditedIds = new Set(audited.map((c) => c.state_id));
  const pre = [].concat(data.preclassified?.coverage || data.preclassified || [])
    .filter((p) => !auditedIds.has(p.state_id))
    .map((p) => ({ status: 'covered', name: enumById.get(p.state_id)?.name, ...p, notes: p.notes || 'Pre-classified, not audited' }));
  if (enumerator) {
    const known = new Set([...auditedIds, ...pre.map((p) => p.state_id)]);
    const missing = enumerator.states.filter((s) => !known.has(s.id));
    if (missing.length) console.error(`warning: ${missing.length} enumerated state(s) neither audited nor pre-classified, left out: ${missing.map((s) => s.id).join(', ')}`);
  }
  const coverage = [...audited, ...pre].map((c) => {
    const e = enumById.get(c.state_id) || {};
    return {
      ...c,
      source: c.source || e.source,
      cluster: c.cluster ?? e.cluster,
      description: c.description || e.description,
      component: c.component || e.component,
      priority: c.priority || e.priority,
      required: c.required ?? e.required,
    };
  });

  const hasSource = coverage.some((c) => c.source);
  const isNeed = (c) => !hasSource || NEEDS_SOURCES.has(c.source) || c.status !== 'covered';
  const needs = coverage.filter(isNeed);
  const exists = coverage.filter((c) => !isNeed(c));

  const counts = { gap: 0, partial: 0, covered: 0, recommendation: 0 };
  for (const c of needs) counts[c.status] = (counts[c.status] || 0) + 1;

  const cons = { blocker: 0, misleading: 0, nuisance: 0 };
  for (const c of needs) { const k = consequenceOf(c); if (k) cons[k]++; }
  const findings = needs.filter((c) => deduction(c) > 0);
  // Fixed only when someone looked at the after shot and saw the fix (verify.json).
  const verify = data.shots?.verify || {};
  if (data.shots) data.shots = { ...data.shots, before: { ...data.shots.before } };
  for (const c of findings) {
    const id = String(c.state_id);
    const v = verify[id];
    if (v?.note) c.verifyNote = v.note;
    if (v?.before_shows_bug === false && data.shots?.before?.[id]) { delete data.shots.before[id]; c.noRepro = v.note || true; }
    if (!data.shots?.after?.[id]) continue;
    if (v?.after_shows_fix === true) { c.fixed = true; c.fixState = 'verified'; }
    else c.fixState = 'code';
  }
  const fixedCount = findings.filter((c) => c.fixed).length;
  const codeFixedCount = findings.filter((c) => c.fixState === 'code').length;
  const afterScore = Math.round(scoreOf(findings.filter((c) => !c.fixed)));
  const raw = scoreOf(findings);
  const score = Math.round(raw);

  const srcRank = { taxonomy: 0, 'screen-level': 1, 'feature-specific': 2 };
  const fixes = needs.filter((c) => deduction(c) > 0)
    .sort((a, b) => deduction(b) - deduction(a) || (b.required ? 1 : 0) - (a.required ? 1 : 0) || (srcRank[a.source] ?? 3) - (srcRank[b.source] ?? 3) || idOrder(a, b))
    .slice(0, 3);
  const lifted = Math.round(scoreOf(findings.filter((c) => !fixes.includes(c))));
  // What each fix adds. The top fixes count in order, so their gains add up to the lift.
  for (const c of findings) c.gain = Math.max(1, Math.round(raw / (1 - deduction(c) / 100) - raw));
  let before = score;
  fixes.forEach((c, i) => {
    const after = Math.round(scoreOf(findings.filter((x) => !fixes.slice(0, i + 1).includes(x))));
    c.gain = after - before;
    before = after;
  });

  const clusterOf = (c) => c.cluster || (c.source === 'screen-level' ? 'Whole screen' : null);
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const ctx = { needs, exists, counts, cons, score, lifted, fixes, needsCount: needs.length - counts.recommendation, meta, mockups, tier2, clusterOf, date, shots: data.shots, fixNotes: data.fixNotes || {}, fixedCount, codeFixedCount, afterScore };

  const cssPath = resolve(__dirname, 'templates', 'report.css');
  const css = readFileSync(cssPath, 'utf8');
  const pal = palette(inventory);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>State coverage: ${esc(meta.feature)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Caveat:wght@500&display=swap" rel="stylesheet">
<style>
${css}
${paletteCss(pal)}
</style>
</head>
<body>
<main class="report">
  <header class="report-header">
    <div class="eyebrow">UI state coverage</div>
    <h1>${esc(meta.feature)}</h1>
    <div class="report-meta">
      <span>${esc(date)}</span>${meta.ds_name ? `<span>&middot;</span><span>${esc(meta.ds_name)}</span>` : ''}
      ${meta.project_label ? `<span>&middot;</span><span>${esc(meta.project_label)}</span>` : ''}
    </div>
  </header>
  ${heroSection(ctx)}
  ${fixesSection(ctx)}
  ${allFixesSection(ctx)}
  ${stripSection(ctx)}
  ${matrixSection(ctx)}
  <footer class="report-footer">
    <span>ds-state-gen</span>
    <span>${counts.gap} no design &middot; ${counts.partial} half-built &middot; ${counts.covered} designed &middot; score ${score}/100</span>
  </footer>
</main>
<div class="toast-copied" role="status" aria-live="polite"></div>
<dialog class="lightbox" id="lightbox" aria-label="Screenshot"><form method="dialog"><button class="lightbox-close" aria-label="Close">&times;</button></form><div class="lightbox-body"></div></dialog>
<script>
const SHOTS = ${JSON.stringify(Object.fromEntries(['before', 'after'].flatMap((l) => Object.entries(data.shots?.[l] || {}).map(([id, uri]) => [`${id}|${l}`, uri]))))};
document.querySelectorAll('img[data-shot]').forEach((i) => { if (SHOTS[i.dataset.shot]) i.src = SHOTS[i.dataset.shot]; });
const lb = document.getElementById('lightbox');
function openShots(keys) {
  const body = lb.querySelector('.lightbox-body');
  body.innerHTML = '';
  body.classList.toggle('lightbox-pair', keys.length > 1);
  for (const k of keys) {
    const f = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.textContent = k.endsWith('|after') ? 'After fix' : 'Today';
    const img = document.createElement('img'); img.src = SHOTS[k]; img.alt = cap.textContent;
    f.append(cap, img); body.append(f);
  }
  lb.showModal();
}
lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openShots([b.dataset.open])));
document.querySelectorAll('[data-compare]').forEach((a) => a.addEventListener('click', (e) => {
  const id = a.dataset.compare;
  const keys = [id + '|before', id + '|after'].filter((k) => SHOTS[k]);
  if (!keys.length) return;
  e.preventDefault(); openShots(keys);
}));
function toggleDetail(row) {
  row.classList.toggle('open');
  const d = row.nextElementSibling;
  if (d && d.classList.contains('state-detail')) d.classList.toggle('open');
}
function openFromHash() {
  const row = document.getElementById(location.hash.slice(1));
  if (row && row.classList.contains('expandable') && !row.classList.contains('open')) toggleDetail(row);
}
window.addEventListener('hashchange', openFromHash);
openFromHash();
document.querySelectorAll('.copy-btn').forEach((b) => b.addEventListener('click', async () => {
  const t = b.dataset.prompt;
  try { await navigator.clipboard.writeText(t); }
  catch { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); }
  const n = document.querySelector('.toast-copied'); n.textContent = 'Fix prompt copied. Paste it into your agent.'; n.classList.add('show');
  setTimeout(() => n.classList.remove('show'), 2200);
}));
</script>
</body>
</html>`;
  return { html, card: shareCard(ctx), score, lifted, fixed: fixedCount, fixed_in_code: codeFixedCount, after: fixedCount ? afterScore : undefined, counts, cons, needsCount: ctx.needsCount, exists: exists.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
try {
  const data = loadInput();
  const out = build(data);
  const feature = data.meta?.feature || data.enumerator?.feature?.name || 'report';
  const outPath = resolve(data.meta?.output || resolve(__dirname, 'reports', `${slug(feature)}.html`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.html);
  let cardPath = null;
  if (data.card) {
    cardPath = resolve(dirname(outPath), basename(outPath).replace(/\.html?$/i, '') + '-card.svg');
    writeFileSync(cardPath, out.card);
  }
  console.error(JSON.stringify({ status: 'ok', report: outPath, card: cardPath, score: out.score, lifted: out.lifted, fixed: out.fixed, fixed_in_code: out.fixed_in_code, after: out.after, needs: out.needsCount, exists: out.exists, ...out.counts, ...out.cons }));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
