#!/usr/bin/env node

// quick-scan.mjs — a seconds-long, no-AI scan of a whole repo for signs that the
// states nobody draws are handled at all: offline, session expired, crash screen,
// keyboard and screen reader use, and the rest.
//
// It looks for code patterns, so it can say "we found no offline handling
// anywhere", but not "this page misleads the user". That is the deep audit's job
// (the agent pipeline in CLAUDE.md). Use this one to get a fast first picture.
//
// Usage:
//   node quick-scan.mjs <repo-path>
//        [--entry <file>]      scan one feature: follow imports from this route/page file (repeatable)
//        [--depth N]           how many import hops to follow (default 6)
//        [--scope <dir>]       only scan this subfolder (repeatable, relative to the repo)
//        [--name <label>]      project name for the report (default: folder name)
//        [--out report.html]   default: reports/<name>-quick.html
//        [--json scan.json]    also write the raw results
//        [--no-card]           skip the share card SVG
//        [--no-report]         skip the HTML report (when you only want the JSON outputs)
//        [--inventory inv.json]  write the design system inventory (tokens, components, state
//                              patterns) in the Scanner agent's format; replaces that agent
//        [--files files.json]  write the feature's file list (with --entry) for the Enumerator
//
// Prints a table to stdout. Status line (with timing) goes to stderr.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, basename, relative, join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  'coverage', 'vendor', 'storybook-static', '__tests__', '__mocks__', 'e2e', 'test', 'tests', 'cypress',
  'playwright', 'fixtures', '.vercel', '.output', 'target', 'migrations', 'builds',
]);
// Documentation sites, examples and test packages aren't the product.
const SKIP_DIR_RE = /^(docs|documentation|website|examples?|storybook|[a-z-]*-?tests?)$/i;
export const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.html']);
export const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less']);
export const MARKUP_EXT = new Set(['.jsx', '.tsx', '.vue', '.svelte', '.astro', '.html']);
const SKIP_FILE = /\.(test|spec|stories|story|d)\.[a-z]+$|\.min\.(js|css)$/i;
const MAX_BYTES = 1_000_000;
// Native code we can't read yet. If a repo is mostly this, a score would be meaningless.
const NATIVE_EXT = new Set(['.swift', '.kt', '.dart', '.java', '.m']);
export const native = { count: 0, exts: {} };
// Config files needed to resolve imports (tsconfig paths, workspace package names).
export const configs = { packages: [], tsconfigs: [], shadcn: false };
// Theme CSS inside skipped build folders (some design systems check generated tokens in, e.g. packages/ui/build/css/themes/light.css).
const THEME_CSS = /(^|[-_.\/])(theme|themes|tokens?|variables|vars|semantic|light|dark|colors?|palette)([-_.\/]|$)/i;
const buildCss = [];
function collectThemeCss(dir, root, depth = 0) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth < 4 && e.name !== 'node_modules') collectThemeCss(p, root, depth + 1);
    else if (e.isFile() && STYLE_EXT.has(extname(e.name).toLowerCase()) && THEME_CSS.test(relative(root, p))) {
      try { if (statSync(p).size < MAX_BYTES) buildCss.push({ path: relative(root, p), ext: extname(e.name).toLowerCase(), text: readFileSync(p, 'utf8'), markup: false }); } catch {}
    }
  }
}

export function walk(dir, root, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.storybook') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !SKIP_DIR_RE.test(e.name)) walk(p, root, out);
      else if (e.name === 'build' || e.name === 'dist') collectThemeCss(p, root);
    } else if (e.isFile()) {
      if (e.name === 'package.json') configs.packages.push(relative(root, p));
      else if (/^tsconfig(\.[a-z]+)?\.json$|^jsconfig\.json$/.test(e.name)) configs.tsconfigs.push(relative(root, p));
      else if (e.name === 'components.json') configs.shadcn = true;
      const ext = extname(e.name).toLowerCase();
      if (NATIVE_EXT.has(ext)) { native.count++; native.exts[ext] = (native.exts[ext] || 0) + 1; }
      if (!CODE_EXT.has(ext) && !STYLE_EXT.has(ext)) continue;
      if (SKIP_FILE.test(e.name)) continue;
      let size;
      try { size = statSync(p).size; } catch { continue; }
      if (size > MAX_BYTES) continue;
      const text = readFileSync(p, 'utf8');
      // Skip generated/minified files: very long average lines.
      const lines = text.length ? text.split('\n').length : 1;
      if (text.length / lines > 400) continue;
      out.push({ path: relative(root, p), ext, text, markup: MARKUP_EXT.has(ext) });
    }
  }
  return out;
}

export function lineOf(text, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// The full JSX/HTML opening tag starting at `i` ('<'), skipping over {...} expressions.
export function openTag(text, i) {
  let depth = 0;
  for (let j = i; j < text.length && j < i + 3000; j++) {
    const ch = text[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth <= 0 && text[j - 1] !== '=') return text.slice(i, j + 1);
  }
  return text.slice(i, i + 300);
}

// ---------------------------------------------------------------------------
// Problems: patterns that show a state is broken even where it is handled elsewhere.
// Each returns [{ path, line }].
// ---------------------------------------------------------------------------
const CANVAS = /\b(react-konva|konva|fabric\.Canvas|pixi\.js|@pixi\/|<canvas\b|getContext\(\s*['"]2d)/i;
const POINTER = /\b(onPointerDown|onMouseDown|onClick|onTap|pointerdown|mousedown)\b|\.on\(\s*['"](click|tap|pointerdown|mousedown|pointerup)/;
const KEYS = /\b(onKeyDown|onKeyUp|onKeyPress|keydown|keyup|useHotkeys)\b/;

function canvasFiles(files) {
  return files.filter((f) => f.markup || f.ext === '.ts' || f.ext === '.js').filter((f) => CANVAS.test(f.text) && POINTER.test(f.text));
}

const PROBLEMS = {
  pointerOnlyCanvas: {
    label: 'Canvas that only works with a mouse',
    max: 0,
    find: (files) => canvasFiles(files).filter((f) => !KEYS.test(f.text))
      .map((f) => ({ path: f.path, line: lineOf(f.text, f.text.search(POINTER)) })),
  },
  silentCanvas: {
    label: 'Canvas content hidden from screen readers',
    max: 0,
    find: (files) => canvasFiles(files).filter((f) => !/\baria-[a-z]+|\brole\s*=/.test(f.text))
      .map((f) => ({ path: f.path, line: lineOf(f.text, f.text.search(CANVAS)) })),
  },
  clickableNonButton: {
    label: 'Clickable elements a keyboard can\'t reach (div or span with a click handler)',
    max: 5,
    find: (files) => {
      const hits = [];
      const re = /<(div|span|li|td|tr|img|p|section|article|svg)\b/g;
      for (const f of files) {
        if (!f.markup) continue;
        for (const m of f.text.matchAll(re)) {
          const tag = openTag(f.text, m.index);
          if (!/(\bonClick|@click|\bon:click|v-on:click)\s*=/.test(tag)) continue;
          if (/\b(onKeyDown|onKeyUp|onKeyPress|@keydown|on:keydown|role\s*=|tabIndex|tabindex)\b/.test(tag)) continue;
          hits.push({ path: f.path, line: lineOf(f.text, m.index) });
        }
      }
      return hits;
    },
  },
  imgNoAlt: {
    label: 'Images with no alt text',
    max: 3,
    find: (files) => {
      const hits = [];
      for (const f of files) {
        if (!f.markup) continue;
        for (const m of f.text.matchAll(/<img\b/g)) {
          const tag = openTag(f.text, m.index);
          if (/\balt\s*=|:alt\s*=|\{\s*\.\.\./.test(tag)) continue;
          hits.push({ path: f.path, line: lineOf(f.text, m.index) });
        }
      }
      return hits;
    },
  },
};

// ---------------------------------------------------------------------------
// Checks. Each state lists the signals that suggest it is handled.
//   weight  3 = can stop someone finishing, 2 = misleads or frustrates, 1 = nice to have
//   need    how many different signals count as "handled" (default 1)
//   core    at least one of these signals must be present for "handled"
//   path    a signal matched against the file path instead of its contents
// ---------------------------------------------------------------------------
const GROUPS = [
  ['waiting', 'Waiting'],
  ['empty', 'Nothing there'],
  ['wrong', 'Things going wrong'],
  ['cutoff', 'Being cut off'],
  ['edges', 'Edge cases'],
  ['access', 'Different ways of using it'],
];

export const CHECKS = [
  // Waiting
  { id: 'loading', group: 'waiting', name: 'Loading', weight: 2, need: 2,
    hurts: 'A blank or frozen screen while data loads.',
    signals: [
      { label: 'Skeleton placeholders', re: /\bSkeleton\b|\bskeleton\b/ },
      { label: 'Spinners', re: /\b(Spinner|Loader2?|LoadingSpinner|CircularProgress|Loading(Indicator|Overlay)?)\b/ },
      { label: 'Suspense fallbacks', re: /<Suspense\b[^>]*fallback|\bfallback=\{/ },
      { label: 'aria-busy', re: /aria-busy/ },
    ] },
  { id: 'slow', group: 'waiting', name: 'Slow or stuck requests', weight: 2, need: 1, core: ['msg'],
    hurts: 'A spinner that never ends, with no hint that something is wrong.',
    signals: [
      { key: 'msg', label: '"Taking longer than usual" copy', re: /taking (longer|a while|too long)|still (loading|working)|this (may|might|can) take|slow (connection|network)/i },
      { label: 'Request timeouts', re: /AbortSignal\.timeout|\btimeout\s*:\s*\d{3,}|setTimeout\([^)]*abort\(/ },
      { label: 'Connection quality checks', re: /navigator\.connection|effectiveType/ },
    ] },
  { id: 'pending', group: 'waiting', name: 'Saving in progress', weight: 2,
    hurts: 'Double submits, or no sign that a click did anything.',
    signals: [
      { label: 'Buttons disabled while saving', re: /disabled=\{[^}]{0,60}\b(isSubmitting|isPending|isLoading|isSaving|loading|submitting|pending|saving)\b/ },
      { label: 'Button loading prop', re: /<Button\b[^>]{0,200}\bloading=\{/ },
    ] },

  // Nothing there
  { id: 'empty', group: 'empty', name: 'Empty lists', weight: 2,
    hurts: 'A blank area that looks broken instead of explaining what goes here.',
    signals: [
      { label: 'Empty state component', re: /\bEmpty(State|Placeholder|View)?\b\s*[({/>]|<Empty\w*/ },
      { label: '"No … yet" copy', re: /\bNo [a-z][a-z ]{1,30} (yet|found)\b|nothing (here|to show|yet)|get started by/i },
    ] },
  { id: 'no-results', group: 'empty', name: 'No search results', weight: 1,
    hurts: 'Search that returns nothing without saying so, or offering a way out.',
    signals: [
      { label: '"No results" copy', re: /no (results|matches)|nothing match(es|ed)|didn'?t match/i },
      { label: 'Clear filters action', re: /clear (all )?filters|reset filters/i },
    ] },
  { id: 'first-time', group: 'empty', name: 'First-time use', weight: 1,
    hurts: 'New users dropped into an empty tool with no guidance.',
    signals: [
      { label: 'Onboarding', re: /\bonboarding\b|getting[ -_]?started|product[ -_]?tour|coach ?mark|isFirst(Time|Visit)|hasSeen[A-Z]/i },
    ] },

  // Things going wrong
  { id: 'crash', group: 'wrong', name: 'Crash screen', weight: 3,
    hurts: 'One broken component takes down the whole page, often to a white screen.',
    signals: [
      { label: 'Error boundaries', re: /componentDidCatch|getDerivedStateFromError|<ErrorBoundary\b|export (function|const) ErrorBoundary|errorElement\s*[:=]|onErrorCaptured/ },
      { label: 'Framework error pages', path: /(^|\/)(global-error|error|_error|\+error|500)\.(tsx|jsx|js|ts|vue|svelte|astro)$/ },
    ] },
  { id: 'not-found', group: 'wrong', name: 'Page not found', weight: 1,
    hurts: 'A dead link shows a framework default or a blank page.',
    signals: [
      { label: '404 page', path: /(^|\/)(not-found|404|\$|\[\.\.\.[a-z]*\]|\[\[\.\.\.[a-z]*\]\])\.(tsx|jsx|js|vue|svelte|astro)$/ },
      { label: '"Not found" copy', re: /page (not found|doesn'?t exist|does not exist|you'?re looking for)|\bnotFound\(\)/i },
      { label: '404 in a shared error page', re: /\b404\s*:\s*\{|(errorCode|status)\s*[!=]==?\s*404\b|404 not found/i },
    ] },
  { id: 'errors', group: 'wrong', name: 'Error messages', weight: 3, need: 2,
    hurts: 'Something fails and the user is never told, or told in developer language.',
    signals: [
      { label: 'Error toasts', re: /toast[\s\S]{0,120}(destructive|error)|toast\.error\(|variant[=:]\s*["']destructive/ },
      { label: 'Alert components', re: /role=["']alert["']|<Alert\b/ },
      { label: 'Inline field errors', re: /<FormMessage\b|aria-invalid|aria-errormessage/ },
    ] },
  { id: 'retry', group: 'wrong', name: 'Retry after failure', weight: 3, core: ['ui'],
    hurts: 'After an error the only way forward is to reload and hope.',
    signals: [
      { key: 'ui', label: '"Try again" / "Retry" buttons', re: />\s*(Try again|Retry|Reload|Refresh)\s*</i },
      { key: 'ui', label: 'Retry copy in translations', re: /(msg|t|_)`\s*(Try again|Retry)|["'](Try again|Retry)["']/ },
      { label: 'Refetch / reload calls', re: /\brefetch\(\)|\.retry\(|window\.location\.reload\(|\brevalidate\(\)/ },
    ] },
  { id: 'validation', group: 'wrong', name: 'Invalid input', weight: 2, need: 2,
    hurts: 'Forms that reject input without saying what is wrong or where.',
    signals: [
      { label: 'Schema validation', re: /zodResolver|yupResolver|valibotResolver|z\.object\(|Yup\.object\(/ },
      { label: 'Field error messages', re: /<FormMessage\b|errors\.[a-zA-Z]+\??\.message|fieldState\.error/ },
      { label: 'aria-invalid', re: /aria-invalid/ },
    ] },

  // Being cut off
  { id: 'offline', group: 'cutoff', name: 'Offline', weight: 2,
    hurts: 'Actions silently fail when the connection drops.',
    signals: [
      { label: 'Online/offline detection', re: /navigator\.onLine|addEventListener\(\s*['"](online|offline)['"]|\buse(Network|Online|IsOnline|NetworkState)\b|\bisOnline\b/ },
      { label: '"You\'re offline" copy', re: /you('| a)re offline|no (internet|network) connection|connection (lost|restored)/i },
      { label: 'Service worker', re: /serviceWorker\.register|workbox/ },
    ] },
  { id: 'session', group: 'cutoff', name: 'Session expired', weight: 3, core: ['msg'],
    hurts: 'Users are logged out mid-task and lose what they were doing, with no explanation.',
    signals: [
      { key: 'msg', label: '"Session expired" copy', re: /session (has )?expired|sign(ed)? in again|log(ged)? in again|(signed|logged) out (due|because)/i },
      { label: '401 handling', re: /status(Code)?\s*===?\s*401|\b401\b\s*[:)]|UNAUTHORIZED/ },
      { label: 'Token refresh', re: /refresh[_-]?token|tokenRefresh/i },
    ] },
  { id: 'permission', group: 'cutoff', name: 'No permission', weight: 2,
    hurts: 'Users hit a wall with no explanation or way to ask for access.',
    signals: [
      { label: '"No access" copy', re: /(don'?t|do not) have (access|permission)|permission denied|access denied|not (allowed|authori[sz]ed) to|request access/i },
      { label: '403 handling', re: /status(Code)?\s*===?\s*403|\bFORBIDDEN\b/ },
    ] },
  { id: 'unsaved', group: 'cutoff', name: 'Leaving with unsaved work', weight: 3,
    hurts: 'A closed tab or back button throws away work without warning.',
    signals: [
      { label: 'Leave-page warning', re: /beforeunload|useBlocker|unstable_usePrompt|\busePrompt\b|onbeforeunload/ },
      { label: '"Unsaved changes" copy', re: /unsaved changes|discard (changes|draft)|changes (will be|may be) lost/i },
      { label: 'Autosave or drafts', re: /auto-?save|saveDraft|localStorage\.setItem\([^)]{0,40}draft/i },
    ] },

  // Edge cases
  { id: 'limits', group: 'edges', name: 'Too long or too big', weight: 1,
    hurts: 'Input over a limit is rejected after the fact, or silently cut.',
    signals: [
      { label: 'Length limits', re: /maxLength=\{?|\.max\(\d+[,)]/ },
      { label: 'Remaining-count copy', re: /characters? (left|remaining)|remaining characters/i },
      { label: 'File size limits', re: /max(File)?Size|file (is )?too (large|big)|exceeds (the )?(maximum|limit)/i },
    ] },
  { id: 'rate-limit', group: 'edges', name: 'Too many requests', weight: 1,
    hurts: 'Rate-limited actions fail with a generic error.',
    signals: [
      { label: 'Rate limit handling', re: /\b429\b|too many requests|rate[ -_]?limit/i },
    ] },
  { id: 'conflict', group: 'edges', name: 'Someone else changed it', weight: 1,
    hurts: 'Two people edit the same thing and one silently overwrites the other.',
    signals: [
      { label: 'Conflict handling', re: /\b409\b|CONFLICT\b|modified by (someone|another)|someone else (has )?(changed|edited|updated)|out of date|was (changed|updated) (elsewhere|by)/ },
    ] },
  { id: 'stale-app', group: 'edges', name: 'Outdated app after a release', weight: 1,
    hurts: 'After a deploy, open tabs break when they try to load code that no longer exists.',
    signals: [
      { label: 'Chunk load recovery', re: /ChunkLoadError|Loading chunk \S+ failed|Failed to fetch dynamically imported module|vite:preloadError/ },
      { label: '"New version available" prompt', re: /new version (is )?available|update available|reload to update|skipWaiting/i },
    ] },

  // Different ways of using it
  { id: 'keyboard', group: 'access', name: 'Keyboard only', weight: 3, need: 2, core: ['focus'],
    problems: ['pointerOnlyCanvas', 'clickableNonButton'],
    hurts: 'People who can\'t use a mouse can\'t reach or operate controls.',
    signals: [
      { key: 'focus', label: 'Visible focus styles', re: /:focus-visible|focus-visible:/ },
      { label: 'Keyboard handlers', re: /\b(onKeyDown|onKeyUp)\b|addEventListener\(\s*['"]key(down|up)|@keydown|on:keydown|useHotkeys/ },
      { label: 'Skip link', re: /skip to (main )?content|skip-link|skip-nav|skipnav/i },
    ] },
  { id: 'screen-reader', group: 'access', name: 'Screen reader', weight: 3, need: 2, core: ['live'],
    problems: ['silentCanvas', 'imgNoAlt'],
    hurts: 'Blind users can\'t tell what controls do or when something changes.',
    signals: [
      { key: 'live', label: 'Live announcements (aria-live, role=status/alert)', re: /aria-live|role=["'](status|alert|log)["']/ },
      { label: 'Screen-reader-only text', re: /\bsr-only\b|VisuallyHidden|visually-hidden/ },
      { label: 'aria-label on controls', re: /aria-label(ledby)?=/ },
    ] },
  { id: 'responsive', group: 'access', name: 'Small screens', weight: 2,
    hurts: 'Layouts that overflow or hide actions on a phone.',
    signals: [
      { label: 'Breakpoints', re: /@media[^{]*(min|max)-width|\b(sm|md|lg|xl):[a-z-]+\d?|useMediaQuery|matchMedia\(/ },
    ] },
  { id: 'reduced-motion', group: 'access', name: 'Reduced motion', weight: 1,
    hurts: 'Animations that can make people with vestibular disorders feel sick.',
    signals: [
      { label: 'prefers-reduced-motion', re: /prefers-reduced-motion|motion-reduce:|motion-safe:|useReducedMotion|reducedMotion/ },
    ] },
  { id: 'high-contrast', group: 'access', name: 'High contrast', weight: 1,
    hurts: 'Controls that disappear in Windows high-contrast mode.',
    signals: [
      { label: 'Contrast / forced colours', re: /prefers-contrast|forced-colors|-ms-high-contrast|contrast-more:/ },
    ] },
  { id: 'print', group: 'access', name: 'Print', weight: 1,
    hurts: 'Printing gives navigation, buttons and cut-off content.',
    signals: [
      { label: 'Print styles', re: /@media print|\bprint:[a-z]/ },
    ] },
];

// Design system building blocks that these states are made from.
const BLOCKS = [
  ['Skeleton', /^skeleton/i], ['Spinner / Loader', /^(spinner|loader|loading)/i], ['Alert', /^alert(?!-dialog)/i],
  ['Toast', /^(toast|toaster|sonner|use-toast)/i], ['Empty state', /^empty/i], ['Banner', /^banner/i],
  ['Progress', /^progress/i], ['Dialog', /^(dialog|modal|alert-dialog)/i], ['Tooltip', /^tooltip/i],
];

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
// A state with a concrete problem found (e.g. a mouse-only canvas) earns less than one that is merely thin.
const CREDIT = { handled: 1, partial: 0.5, flagged: 0.25, missing: 0 };

export function scan(files) {
  const problemCache = {};
  const problem = (id) => (problemCache[id] ??= PROBLEMS[id].find(files));

  const results = CHECKS.map((c) => {
    const signals = c.signals.map((s) => {
      const hits = [];
      let fileCount = 0;
      for (const f of files) {
        if (s.path) {
          if (s.path.test(f.path)) { fileCount++; if (hits.length < 3) hits.push({ path: f.path, line: 1 }); }
          continue;
        }
        const idx = f.text.search(s.re);
        if (idx < 0) continue;
        fileCount++;
        if (hits.length < 3) hits.push({ path: f.path, line: lineOf(f.text, idx) });
      }
      return { key: s.key, label: s.label, files: fileCount, samples: hits };
    });
    const problems = (c.problems || []).map((id) => {
      const all = problem(id);
      return { id, label: PROBLEMS[id].label, count: all.length, over: all.length > PROBLEMS[id].max, samples: all.slice(0, 3) };
    });

    const found = signals.filter((s) => s.files > 0);
    const coreOk = !c.core || found.some((s) => c.core.includes(s.key));
    const need = c.need || 1;
    let status = found.length === 0 ? 'missing' : found.length >= need && coreOk ? 'handled' : 'partial';
    const flagged = status !== 'missing' && problems.some((p) => p.over);
    if (flagged) status = 'partial';
    const credit = flagged ? CREDIT.flagged : CREDIT[status];
    return { id: c.id, group: c.group, name: c.name, weight: c.weight, hurts: c.hurts, status, flagged, lost: c.weight * (1 - credit), signals, problems };
  });

  const blocks = BLOCKS.map(([label, re]) => {
    const f = files.find((x) => (x.markup || x.ext === '.ts') && re.test(basename(x.path)));
    return { label, path: f ? f.path : null };
  });

  const total = results.reduce((s, r) => s + r.weight, 0);
  const earned = results.reduce((s, r) => s + r.weight - r.lost, 0);
  const score = Math.round((earned / total) * 100);
  const counts = { handled: 0, partial: 0, missing: 0 };
  for (const r of results) counts[r.status]++;
  return { score, counts, results, blocks };
}

// ---------------------------------------------------------------------------
// Feature files: follow imports from a route or page file, so a scan (and the
// Enumerator) covers one feature without hand-picking folders. Resolves
// relative imports, tsconfig "paths" aliases and workspace package names.
// ---------------------------------------------------------------------------
const RESOLVE_EXT = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte', '.astro', '.css', '.scss'];
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?!type\b)(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

// JSON with comments and trailing commas (tsconfig). Comment markers inside
// strings, like "@/*": ["./*"], are left alone.
function readJsonLoose(p) {
  try {
    const src = readFileSync(p, 'utf8');
    let out = '';
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j;
      } else if (ch === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        out += '\n';
      } else if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end < 0 ? src.length : end + 1;
      } else out += ch;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch { return null; }
}

export function resolver(repo, files) {
  const fileSet = new Set(files.map((f) => f.path));
  const packages = configs.packages.map((p) => ({ dir: dirname(p), name: readJsonLoose(join(repo, p))?.name }))
    .filter((p) => p.name).sort((a, b) => b.name.length - a.name.length);

  // tsconfig paths, following "extends" for relative parents.
  const tsCache = new Map();
  function tsPaths(cfgPath) {
    if (tsCache.has(cfgPath)) return tsCache.get(cfgPath);
    tsCache.set(cfgPath, []);
    const cfg = readJsonLoose(join(repo, cfgPath)) || {};
    let out = [];
    const ext = [].concat(cfg.extends || []).find((e) => e.startsWith('.'));
    if (ext) out = tsPaths(relative(repo, resolve(repo, dirname(cfgPath), ext.endsWith('.json') ? ext : ext + '.json')));
    const co = cfg.compilerOptions || {};
    if (co.paths) {
      const base = join(dirname(cfgPath), co.baseUrl || '.');
      out = Object.entries(co.paths).map(([k, v]) => ({ key: k, targets: v.map((t) => join(base, t)) })).concat(out);
    }
    tsCache.set(cfgPath, out);
    return out;
  }
  const tsDirs = configs.tsconfigs.filter((p) => /^tsconfig\.json$|^jsconfig\.json$/.test(basename(p))).map((p) => ({ dir: dirname(p), p }));
  function nearestTs(fromPath) {
    let d = dirname(fromPath);
    for (;;) {
      const hit = tsDirs.find((t) => t.dir === d);
      if (hit) return hit.p;
      if (d === '.' || d === '') return null;
      d = dirname(d);
    }
  }

  function tryFile(base) {
    base = base.replace(/\\/g, '/').replace(/^\.\//, '');
    if (fileSet.has(base)) return base;
    for (const e of RESOLVE_EXT) if (fileSet.has(base + e)) return base + e;
    for (const e of RESOLVE_EXT) if (fileSet.has(base + '/index' + e)) return base + '/index' + e;
    return null;
  }

  return function resolveImport(spec, from) {
    if (spec.startsWith('.')) return tryFile(join(dirname(from), spec));
    const ts = nearestTs(from);
    if (ts) {
      for (const { key, targets } of tsPaths(ts)) {
        const star = key.endsWith('*');
        const prefix = star ? key.slice(0, -1) : key;
        if (star ? !spec.startsWith(prefix) : spec !== key) continue;
        for (const t of targets) {
          const hit = tryFile(star ? t.replace('*', spec.slice(prefix.length)) : t);
          if (hit) return hit;
        }
      }
    }
    const pkg = packages.find((p) => spec === p.name || spec.startsWith(p.name + '/'));
    if (pkg) {
      const rest = spec.slice(pkg.name.length).replace(/^\//, '');
      const hit = tryFile(join(pkg.dir, rest || 'index')) || tryFile(join(pkg.dir, 'src', rest || 'index'));
      if (hit) return hit;
    }
    // Bare paths like 'components/Foo' resolve from the importing package's root (baseUrl ".").
    if (/^[a-zA-Z]/.test(spec)) {
      const own = packages.filter((p) => p.dir === '.' || from.startsWith(p.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
      if (own) return tryFile(join(own.dir, spec)) || tryFile(join(own.dir, 'src', spec));
    }
    return null;
  };
}

// Breadth-first from the entry files. Server-only modules are skipped: they
// can't show the user anything. App-shell layouts that aren't about this
// feature are listed but not followed, or one DefaultLayout pulls in the whole app.
const GENERIC_WORDS = new Set(['app', 'apps', 'src', 'pages', 'page', 'routes', 'route', 'index', 'layout', 'project', 'ref', 'id', 'slug', 'token', 'studio', 'remix', 'web', 'www', 'tsx', 'jsx', 'vue', 'svelte']);
export const SHELL = /(^|\/)(layouts?|shell|app-shell)(\/|$)|Layout\.(tsx|jsx|vue|svelte)$/;

export function featureFiles(repo, files, entries, maxDepth = 6) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const resolveImport = resolver(repo, files);
  const seen = new Map();
  let frontier = entries.map((e) => relative(repo, resolve(repo, e)));
  for (const e of frontier) if (!byPath.has(e)) throw new Error(`Entry file not found (or skipped): ${e}`);
  const keywords = [...new Set(frontier.flatMap((e) => e.toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w)))];
  const isShell = (p) => SHELL.test(p) && !keywords.some((k) => p.toLowerCase().includes(k));
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const p of frontier) {
      if (seen.has(p)) continue;
      seen.set(p, depth);
      const f = byPath.get(p);
      if (!f || STYLE_EXT.has(f.ext) || (depth > 0 && isShell(p))) continue;
      for (const m of f.text.matchAll(IMPORT_RE)) {
        const hit = resolveImport(m[1] || m[2] || m[3], p);
        if (hit && !seen.has(hit) && !/(^|\/)(server|server-only|prisma|migrations)(\/|\.|$)|\.server\./.test(hit)) next.push(hit);
      }
    }
    frontier = next;
  }
  return [...seen.entries()].map(([p, depth]) => ({ f: byPath.get(p), depth })).filter((x) => x.f)
    .sort((a, b) => a.depth - b.depth || a.f.path.localeCompare(b.f.path));
}

// ---------------------------------------------------------------------------
// Inventory: the design system's tokens, components and state patterns, in
// the same shape the Scanner agent writes, so the deep audit and the report
// can use it without spending an agent run on it.
// ---------------------------------------------------------------------------
const COLOR_VALUE = /^\s*(#[0-9a-f]{3,8}\b|(rgba?|hsla?|oklch|oklab|lab|lch|color)\(|-?\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%)/i;

function tokenKind(name, value) {
  const n = name.toLowerCase();
  if (/radius|rounded/.test(n)) return 'radii';
  if (/shadow/.test(n)) return 'shadows';
  if (/duration|easing|ease|transition|animation|motion/.test(n)) return 'motion';
  if (/(^|-)z(-index)?(-|$)|zindex/.test(n)) return 'z_index';
  if (/breakpoint|screen-/.test(n)) return 'breakpoints';
  if (/font|leading|tracking|line-height|letter|text-(xs|sm|base|lg|xl|\d)/.test(n) && !COLOR_VALUE.test(value)) return 'typography';
  if (COLOR_VALUE.test(value) || /color|colour|-bg|background|foreground|border|ring|primary|secondary|accent|muted|destructive|danger|warning|success/.test(n)) return 'colors';
  if (/space|spacing|gap|gutter|size|width|height|inset/.test(n)) return 'spacing';
  return null;
}

function cssTokens(files) {
  const tokens = { colors: [], spacing: [], typography: [], radii: [], shadows: [], motion: [], z_index: [], breakpoints: [] };
  const byName = new Map();
  // Theme files first, CSS modules (usually one widget's overrides) last, so the first definition of a token is the design system's.
  const rank = (f) => (THEME_CSS.test(f.path) ? 0 : 1) + (/\.module\.(css|scss)$/.test(f.path) ? 2 : 0) + (DS_DIR.test(f.path) ? 0 : 0.5);
  const styled = files.concat(buildCss).filter((f) => STYLE_EXT.has(f.ext) || f.ext === '.vue' || f.ext === '.svelte').sort((a, b) => rank(a) - rank(b));
  for (const f of styled) {
    // Innermost blocks; the selector (or wrapping @media) says whether it's the dark theme.
    for (const m of f.text.matchAll(/([^{}]*)\{([^{}]*--[a-zA-Z][\w-]*\s*:[^{}]*)\}/g)) {
      const before = f.text.slice(Math.max(0, m.index - 200), m.index);
      const dark = /\.dark(?![\w-])|\[data-theme=["']?dark|prefers-color-scheme:\s*dark/.test(m[1] + before.slice(before.lastIndexOf('}') + 1));
      for (const d of m[2].matchAll(/(--[a-zA-Z][\w-]*)\s*:\s*([^;]+);?/g)) {
        const name = d[1];
        const value = d[2].trim();
        const line = lineOf(f.text, m.index + m[1].length + d.index);
        const t = byName.get(name);
        if (t) { if (dark && !t.dark) t.dark = value; continue; }
        if (dark) continue; // light values first; a dark-only token is rare
        const kind = tokenKind(name, value);
        if (!kind) continue;
        const tok = { name, value, file: `${f.path}:${line}` };
        byName.set(name, tok);
        tokens[kind].push(tok);
      }
    }
  }
  for (const k of Object.keys(tokens)) {
    tokens[k] = tokens[k].slice(0, k === 'colors' ? 120 : 40).map((t) => (t.dark && t.dark !== t.value ? { ...t, value: `${t.value} (light) / ${t.dark} (dark)` } : t));
    for (const t of tokens[k]) delete t.dark;
  }
  return tokens;
}

// Balanced {...} starting at the first '{' at or after i.
function braceBlock(text, i) {
  const s = text.indexOf('{', i);
  if (s < 0) return '';
  let depth = 0;
  for (let j = s; j < text.length && j < s + 8000; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(s + 1, j);
  }
  return '';
}
function topKeys(block) {
  const keys = [];
  let depth = 0;
  for (const m of block.matchAll(/[{}]|(?:^|[,\n])\s*['"]?([\w-]+)['"]?\s*:/g)) {
    if (m[0] === '{') depth++;
    else if (m[0] === '}') depth--;
    else if (depth === 0 && m[1]) keys.push(m[1]);
  }
  return keys;
}

export const DS_DIR = /(^|\/)(ui|primitives|design-system|ds|components\/ui|components\/common|components\/base)(\/|$)/i;

function components(files) {
  const out = [];
  for (const f of files) {
    if (!(f.markup || f.ext === '.ts') || !DS_DIR.test(dirname(f.path)) || /(^|\/)(hooks?|utils?|lib)\//.test(f.path)) continue;
    const exports = new Set();
    for (const m of f.text.matchAll(/export\s+(?:default\s+)?(?:const|function|class)\s+([A-Z]\w*)/g)) exports.add(m[1]);
    for (const m of f.text.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of m[1].split(',')) { const x = n.trim().split(/\s+as\s+/).pop(); if (/^[A-Z]/.test(x)) exports.add(x); }
    if (!exports.size) continue;
    const variants = [];
    for (const m of f.text.matchAll(/\bvariants\s*:\s*\{/g)) {
      const block = braceBlock(f.text, m.index);
      for (const group of topKeys(block)) {
        const gi = block.search(new RegExp(`['"]?${group}['"]?\\s*:\\s*\\{`));
        if (gi < 0) continue;
        for (const v of topKeys(braceBlock(block, gi))) variants.push({ class: `${group}=${v}` });
      }
    }
    const line = lineOf(f.text, Math.max(0, f.text.search(/export\s/)));
    out.push({ name: basename(f.path).replace(/\.[^.]+$/, ''), exports: [...exports].slice(0, 12), file: `${f.path}:${line}`, ...(variants.length ? { variants: variants.slice(0, 20) } : {}) });
  }
  return out.concat(bemComponents(files)).sort((a, b) => a.file.localeCompare(b.file)).slice(0, 150);
}

// CSS components written as BEM (.btn, .btn--primary, .modal__footer): a base
// class with at least one --modifier counts as a component.
function bemComponents(files) {
  const bases = new Map();
  for (const f of files) {
    if (!STYLE_EXT.has(f.ext)) continue;
    for (const m of f.text.matchAll(/\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:__([a-z0-9-]+))?--([a-z0-9-]+)/g)) {
      const base = m[1];
      if (!bases.has(base)) {
        const def = f.text.search(new RegExp(`\\.${base}(?![\\w-])`));
        bases.set(base, { name: base, base_class: `.${base}`, file: `${f.path}:${lineOf(f.text, def >= 0 ? def : m.index)}`, variants: new Set() });
      }
      bases.get(base).variants.add(`.${base}${m[2] ? '__' + m[2] : ''}--${m[3]}`);
    }
  }
  return [...bases.values()].map((b) => ({ ...b, variants: [...b.variants].slice(0, 20).map((c) => ({ class: c })) }));
}

const PATTERN_MAP = { loading: ['loading', 'pending'], empty: ['empty', 'no-results'], error: ['errors', 'crash', 'retry'], offline: ['offline'], responsive: ['responsive'], focus: ['keyboard'], accessibility: ['screen-reader', 'reduced-motion', 'high-contrast'], session: ['session', 'permission', 'unsaved'] };

export function inventory(repo, files, res, name) {
  const rootPkg = readJsonLoose(join(repo, 'package.json')) || {};
  // Framework comes from the package holding the most UI files, not from any
  // package (a monorepo's small API service shouldn't make it "next").
  const pkgs = configs.packages.map((p) => ({ dir: dirname(p), json: readJsonLoose(join(repo, p)) || {} }));
  const owner = (path) => pkgs.filter((p) => p.dir === '.' || path.startsWith(p.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
  const uiCount = new Map();
  for (const f of files) if (f.markup) { const o = owner(f.path); if (o) uiCount.set(o, (uiCount.get(o) || 0) + 1); }
  const app = [...uiCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const allDeps = {};
  for (const p of [pkgs.find((x) => x.dir === '.'), app].filter(Boolean)) Object.assign(allDeps, p.json.dependencies, p.json.devDependencies);
  for (const p of pkgs) for (const d of Object.keys({ ...p.json.dependencies, ...p.json.devDependencies })) if (/^@radix-ui\/|^class-variance-authority$|^@mui\/|^@chakra-ui\/|^@mantine\//.test(d)) allDeps[d] = true;
  const has = (re) => Object.keys(allDeps).some((d) => re.test(d));
  const framework = has(/^next$/) ? 'next' : has(/^@remix-run\/|^react-router$/) ? 'react (remix / react-router)' : has(/^nuxt$/) ? 'nuxt' : has(/^vue$/) ? 'vue' : has(/^@sveltejs\/kit$|^svelte$/) ? 'svelte' : has(/^astro$/) ? 'astro' : has(/^react$/) ? 'react' : 'unknown';
  const dsFramework = configs.shadcn || (has(/^@radix-ui\//) && has(/^class-variance-authority$/)) ? 'shadcn' : has(/^@mui\//) ? 'material' : has(/^@carbon\//) ? 'carbon' : has(/^@shopify\/polaris/) ? 'polaris' : has(/^@chakra-ui\//) ? 'chakra' : has(/^antd$/) ? 'ant' : has(/^@mantine\//) ? 'mantine' : 'custom';
  const uiPkg = configs.packages.map((p) => ({ dir: dirname(p), name: readJsonLoose(join(repo, p))?.name })).find((p) => p.name && DS_DIR.test(p.dir));
  const state_patterns = {};
  for (const [k, ids] of Object.entries(PATTERN_MAP)) {
    state_patterns[k] = res.results.filter((r) => ids.includes(r.id)).flatMap((r) => r.signals.filter((s) => s.files)
      .map((s) => ({ type: s.label, file: `${s.samples[0].path}:${s.samples[0].line}`, usage: `${s.files} file${s.files === 1 ? '' : 's'}` })));
  }
  return {
    project: { name: rootPkg.name || name, path: repo, framework, ds_name: uiPkg?.name || null, ds_framework: dsFramework, notes: 'Generated by quick-scan.mjs (no agent). Tokens are CSS custom properties; components are exports from design-system folders.' },
    tokens: cssTokens(files),
    components: components(files),
    state_patterns,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function slug(s) { return String(s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }

const STATUS = {
  handled: { label: 'Handled', badge: 'badge-covered', dot: '●' },
  partial: { label: 'Partly', badge: 'badge-partial', dot: '◐' },
  missing: { label: 'Not found', badge: 'badge-gap', dot: '○' },
};

// Worst first: most points lost.
function worst(results) {
  return results.filter((r) => r.lost > 0).sort((a, b) => b.lost - a.lost || b.weight - a.weight);
}

function summaryText(res, fileCount, ms) {
  const miss = res.results.filter((r) => r.status === 'missing' && r.weight >= 2).map((r) => r.name.toLowerCase());
  const probs = res.results.flatMap((r) => r.problems.filter((p) => p.over).map((p) => p.label.toLowerCase()));
  const parts = [`Scanned ${fileCount.toLocaleString('en-US')} files in ${(ms / 1000).toFixed(1)}s. Found signs that ${res.counts.handled} of ${res.results.length} states are handled.`];
  if (miss.length) parts.push(`Nothing found for ${listJoin(miss)}.`);
  if (probs.length) parts.push(`Also found: ${listJoin([...new Set(probs)])}.`);
  return parts.join(' ');
}
function listJoin(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }

function table(res) {
  const rows = [];
  for (const [g, gl] of GROUPS) {
    rows.push(`\n${gl}`);
    for (const r of res.results.filter((x) => x.group === g)) {
      const found = r.signals.filter((s) => s.files).map((s) => `${s.label} (${s.files})`).join(', ') || '—';
      const probs = r.problems.filter((p) => p.count).map((p) => `${p.count} × ${p.label}`).join('; ');
      rows.push(`  ${STATUS[r.status].dot} ${r.name.padEnd(30)} ${STATUS[r.status].label.padEnd(10)} ${trunc(found, 90)}${probs ? `\n      ! ${probs}` : ''}`);
    }
  }
  return rows.join('\n');
}

function evidence(samples) {
  return samples.map((s) => `<code>${esc(s.path)}:${s.line}</code>`).join('<br>');
}

function html(res, meta) {
  const css = readFileSync(resolve(__dirname, 'templates', 'report.css'), 'utf8');
  const band = res.score < 50 ? 'gap' : res.score < 75 ? 'partial' : 'covered';
  const groups = GROUPS.map(([g, gl]) => {
    const rows = res.results.filter((r) => r.group === g)
      .sort((a, b) => b.lost - a.lost || b.weight - a.weight).map((r) => {
      const found = r.signals.filter((s) => s.files);
      const notFound = r.signals.filter((s) => !s.files);
      const probs = r.problems.filter((p) => p.count);
      return `<tr>
  <td><strong>${esc(r.name)}</strong><div class="qs-hurts">${esc(r.hurts)}</div></td>
  <td>${`<span class="badge ${STATUS[r.status].badge}">${STATUS[r.status].label}</span>`}<div class="qs-weight">${'●'.repeat(r.weight)}${'○'.repeat(3 - r.weight)}</div></td>
  <td>${found.map((s) => `<div class="qs-sig"><span class="qs-yes">✓</span> ${esc(s.label)} <span class="qs-n">${s.files} file${s.files === 1 ? '' : 's'}</span><div class="qs-ev">${evidence(r.status === 'handled' ? s.samples.slice(0, 1) : s.samples)}</div></div>`).join('')}
      ${notFound.map((s) => `<div class="qs-sig qs-missing"><span class="qs-no">✗</span> ${esc(s.label)}</div>`).join('')}
      ${probs.map((p) => `<div class="qs-sig qs-problem"><span class="qs-warn">!</span> ${p.count} × ${esc(p.label)}<div class="qs-ev">${evidence(p.samples)}${p.count > 3 ? '<br>…' : ''}</div></div>`).join('')}</td>
</tr>`;
    }).join('\n');
    return `<tr><td colspan="3" class="section-divider section-divider-rec">${esc(gl)}</td></tr>\n${rows}`;
  }).join('\n');

  const blocks = res.blocks.map((b) => `<li class="${b.path ? 'qs-block-yes' : 'qs-block-no'}"><strong>${b.path ? '✓' : '✗'} ${esc(b.label)}</strong>${b.path ? `<code>${esc(b.path)}</code>` : '<span>not found</span>'}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quick scan: ${esc(meta.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${css}
.qs-hurts { font-size: 12px; color: var(--report-text-secondary); margin-top: 2px; }
.qs-weight { font-size: 9px; letter-spacing: 1px; color: var(--report-text-tertiary); margin-top: 6px; }
.qs-sig { font-size: 13px; margin-bottom: 6px; }
.qs-n { font-size: 11px; color: var(--report-text-tertiary); }
.qs-ev { margin: 2px 0 0 18px; color: var(--report-text-tertiary); }
.qs-ev code { font-size: 11px; }
.qs-yes { color: var(--status-covered); font-weight: 700; }
.qs-no { color: var(--report-text-tertiary); }
.qs-missing { color: var(--report-text-tertiary); }
.qs-warn { display: inline-block; width: 14px; text-align: center; color: #fff; background: var(--status-gap); border-radius: 99px; font-size: 10px; font-weight: 700; }
.qs-problem { color: var(--status-gap); }
.qs-blocks { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.qs-blocks li { background: var(--report-surface); border: 1px solid var(--report-border); border-radius: var(--report-radius-sm); padding: 10px 12px; font-size: 13px; display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
.qs-blocks code, .qs-blocks span { font-size: 11px; color: var(--report-text-tertiary); }
.qs-block-no strong { color: var(--status-gap); }
.qs-counts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 18px; }
.qs-note { font-size: 13px; color: var(--report-text-secondary); margin-top: 14px; }
.matrix col.c1 { width: 30%; } .matrix col.c2 { width: 120px; }
</style>
</head>
<body>
<main class="report">
  <header class="report-header">
    <div class="eyebrow">UI state coverage · quick scan</div>
    <h1>${esc(meta.name)}</h1>
    <div class="report-meta"><span>${esc(meta.date)}</span><span>&middot;</span><span>${meta.files.toLocaleString('en-US')} files</span><span>&middot;</span><span>${(meta.ms / 1000).toFixed(1)}s</span>${meta.scope ? `<span>&middot;</span><span>${esc(meta.scope)}</span>` : ''}</div>
  </header>
  <div class="hero">
    <div class="card score-card score-band-${band}">
      <div class="eyebrow">Quick scan score</div>
      <div class="score"><span class="score-value">${res.score}</span><span class="score-max">/100</span></div>
      <div class="score-bar" style="color:var(--status-${band})"><div class="score-bar-now" style="width:${res.score}%"></div></div>
      <div class="qs-counts">
        <div class="count count-covered"><div class="count-value">${res.counts.handled}</div><div class="count-label">Handled</div></div>
        <div class="count count-partial"><div class="count-value">${res.counts.partial}</div><div class="count-label">Partly</div></div>
        <div class="count count-gap"><div class="count-value">${res.counts.missing}</div><div class="count-label">Not found</div></div>
      </div>
      <p class="score-how">Weighted by what a missing state does to someone: ●●● can stop them finishing, ●● misleads or frustrates, ● nice to have. Partly counts half, or a quarter when we found a concrete problem.</p>
    </div>
    <div class="card summary-card">
      <div class="eyebrow">Summary</div>
      <p class="summary-text">${esc(meta.summary)}</p>
      <p class="qs-note">This scan looks for code patterns across ${meta.scope ? 'the folders listed above' : 'the whole repo'}. "Handled" means we found signs of it somewhere, not that every screen gets it right. "Not found" is worth checking by hand. For findings about one feature, like what a user actually sees when a save fails, run the deep audit.</p>
    </div>
  </div>
  <section class="section">
    <div class="section-head"><h2>States</h2><p>Worst first in each group. Start with ●●● states marked Not found or Partly.</p></div>
    <div class="matrix-wrap"><table class="matrix"><colgroup><col class="c1"><col class="c2"><col></colgroup>
      <thead><tr><th>State</th><th>Status</th><th>What we found</th></tr></thead>
      <tbody>${groups}</tbody></table></div>
  </section>
  <section class="section">
    <div class="section-head"><h2>Building blocks in the design system</h2><p>The pieces these states are usually made from.</p></div>
    <ul class="qs-blocks">${blocks}</ul>
  </section>
  <footer class="report-footer"><span>ds-state-gen · quick scan</span><span>${res.counts.handled} handled &middot; ${res.counts.partial} partly &middot; ${res.counts.missing} not found &middot; score ${res.score}/100</span></footer>
</main>
</body>
</html>`;
}

function xml(s) { return esc(s).replace(/'/g, '&apos;'); }

function card(res, meta) {
  const band = res.score < 50 ? '#c0392b' : res.score < 75 ? '#a86f00' : '#2a7d4f';
  const rows = worst(res.results).slice(0, 3).map((r, i) => {
    const y = 250 + i * 88;
    const col = r.status === 'missing' || r.flagged ? '#b42318' : '#c4620a';
    return `<circle cx="652" cy="${y - 8}" r="8" fill="${col}"/>
  <text x="676" y="${y}" font-size="26" font-weight="650" fill="#18181b">${xml(trunc(r.name, 30))}</text>
  <text x="676" y="${y + 34}" font-size="21" fill="#6b6b72">${r.status === 'missing' ? 'not found' : r.flagged ? xml(trunc(r.problems.find((p) => p.over).label.toLowerCase(), 44)) : 'partly handled'}</text>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter, -apple-system, 'Segoe UI', system-ui, sans-serif">
  <rect width="1200" height="630" fill="#f6f6f3"/>
  <rect x="40" y="40" width="1120" height="550" rx="28" fill="#ffffff" stroke="#e4e4e0" stroke-width="2"/>
  <text x="96" y="118" font-size="24" font-weight="600" fill="#18181b">${xml(trunc(meta.name, 40))}</text>
  <text x="96" y="152" font-size="19" fill="#95959c" font-family="ui-monospace, Menlo, monospace">${meta.files.toLocaleString('en-US')} files in ${(meta.ms / 1000).toFixed(1)}s</text>
  <text x="1104" y="118" font-size="17" font-weight="600" fill="#95959c" text-anchor="end" letter-spacing="2">UI STATE QUICK SCAN</text>
  <text x="90" y="392" font-size="210" font-weight="700" fill="${band}" letter-spacing="-8">${res.score}</text>
  <text x="${res.score >= 100 ? 470 : 340}" y="392" font-size="46" font-weight="500" fill="#95959c">/100</text>
  <text x="96" y="446" font-size="23" fill="#5f5f66">${res.counts.handled} of ${res.results.length} states handled</text>
  <line x1="600" y1="200" x2="600" y2="470" stroke="#e4e4e0" stroke-width="2"/>
  <text x="640" y="196" font-size="17" font-weight="600" fill="#95959c" letter-spacing="2">WORST FIRST</text>
  ${rows}
  <line x1="96" y1="510" x2="1104" y2="510" stroke="#efefec" stroke-width="2"/>
  <text x="96" y="552" font-size="20" fill="#5f5f66" font-family="ui-monospace, Menlo, monospace">ds-state-gen</text>
  <text x="1104" y="552" font-size="18" fill="#95959c" text-anchor="end">${xml(meta.date)}</text>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function flags(argv) {
  const o = { scope: [], entry: [], positional: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') o.scope.push(argv[++i]);
    else if (a === '--entry') o.entry.push(argv[++i]);
    else if (['--name', '--out', '--json', '--inventory', '--files', '--depth'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a === '--no-card') o.noCard = true;
    else if (a === '--no-report') o.noReport = true;
    else o.positional.push(a);
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = flags(process.argv);
    const repo = o.positional[0] && resolve(o.positional[0]);
    if (!repo || !existsSync(repo)) throw new Error('Usage: node quick-scan.mjs <repo-path> [--entry file] [--scope dir] [--name label] [--out report.html] [--json scan.json] [--inventory inv.json] [--files files.json]');
    const t0 = performance.now();
    // Always read the whole repo once: imports and the inventory need it, and it takes well under a second.
    const all = walk(repo, repo, []);
    if (native.count > all.length) {
      const top = Object.entries(native.exts).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${n} ${e}`).join(', ');
      throw new Error(`This looks like a native app (${top} files, ${all.length} web files). The quick scan only reads web code (JS/TS, Vue, Svelte, CSS), so a score would be wrong.`);
    }
    let feature = null;
    let files = all;
    if (o.entry.length) {
      feature = featureFiles(repo, all, o.entry, o.depth ? Number(o.depth) : undefined);
      files = feature.map((x) => x.f);
    }
    if (o.scope.length) {
      const pre = o.scope.map((d) => relative(repo, resolve(repo, d)).replaceAll('\\', '/') + '/');
      const inScope = all.filter((f) => pre.some((p) => f.path.startsWith(p)));
      const have = new Set(files === all ? [] : files.map((f) => f.path));
      files = files === all ? inScope : files.concat(inScope.filter((f) => !have.has(f.path)));
    }
    const res = scan(files);
    const ms = performance.now() - t0;

    const name = o.name || basename(repo);
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const scopeLabel = [...o.entry.map((e) => `from ${e}`), ...o.scope].join(', ');
    const meta = { name, date, files: files.length, ms, scope: scopeLabel };
    meta.summary = summaryText(res, files.length, ms);

    let outPath = null;
    let cardPath = null;
    if (!o.noReport) {
      outPath = resolve(o.out || resolve(__dirname, 'reports', `${slug(name)}-quick.html`));
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, html(res, meta));
      if (!o.noCard) {
        cardPath = outPath.replace(/\.html?$/i, '') + '-card.svg';
        writeFileSync(cardPath, card(res, meta));
      }
    }
    const write = (p, data) => { mkdirSync(dirname(resolve(p)), { recursive: true }); writeFileSync(resolve(p), JSON.stringify(data, null, 2)); };
    if (o.json) write(o.json, { project: name, scope: scopeLabel || null, scanned_files: files.length, ms: Math.round(ms), ...res });
    if (o.inventory) write(o.inventory, inventory(repo, all, all === files ? res : scan(all), name));
    if (o.files) {
      // UI files first (they're what the Enumerator reads); line counts let the orchestrator set a reading budget.
      const list = (feature || files.map((f) => ({ f, depth: null })))
        .map(({ f, depth }) => ({ path: f.path, depth, lines: f.text.split('\n').length, ui: f.markup, ds: DS_DIR.test(dirname(f.path)) }));
      // Only what the Enumerator should consider: the feature's UI files, plus non-UI files
      // (state, hooks) one hop from the route. Design-system files are left out: the inventory
      // already describes them, and a long list costs tokens just to read.
      const keep = list.filter((x) => (x.ui && !x.ds) || (!x.ds && x.depth !== null && x.depth <= 1));
      write(o.files, keep.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || b.ui - a.ui).map(({ ds, ...x }) => x));
    }

    console.log(`${name}: ${res.score}/100  (${res.counts.handled} handled, ${res.counts.partial} partly, ${res.counts.missing} not found)`);
    console.log(table(res));
    console.error(JSON.stringify({ status: 'ok', report: outPath, card: cardPath, score: res.score, files: files.length, ms: Math.round(ms), ...res.counts }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
