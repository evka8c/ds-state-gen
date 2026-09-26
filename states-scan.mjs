#!/usr/bin/env node
// states-scan.mjs — the script half of the /states skill. No agents, no dependencies.
//
//   node states-scan.mjs check <repo> [--base <branch>] [--paths a b ...] [--depth 1] [--include <path> ...] [--out scope.json] [--verbose]
//     default base: origin/HEAD, else main, else master, else HEAD~1. Output is compact
//     (handled states as {id, at}); --verbose keeps every state and the full inventory.
//   node states-scan.mjs plan "<feature description>" [--repo <repo>] [--out plan.json]
//
// check: works out which files changed (git diff vs base, plus uncommitted and untracked
// files) or takes --paths, follows imports a shallow depth, detects UI types (form, table,
// upload...), lists their states from states.yml and classifies each as handled / doubtful /
// no_signal with file:line evidence. Only "doubtful" states need an AI pass.
// plan: matches UI types from a feature description and lists the states to build.
//
// states.yml is parsed at runtime by a small parser written for its exact shape
// (a map of types, each with a list of flat {name, required, description, ds_hint}
// items). No generated states.json, so the taxonomy can't drift from its source.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, basename, relative, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { walk, lineOf, openTag, slug, scan, featureFiles, inventory, CODE_EXT, MARKUP_EXT, DS_DIR, SHELL, CHECKS } from './quick-scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_LINES = 6000;

// ---------------------------------------------------------------------------
// states.yml
// ---------------------------------------------------------------------------
function scalar(v) {
  v = v.trim();
  if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

export function parseTaxonomy(text) {
  const out = { component_types: {}, screen_level_states: { description: '', states: [] } };
  let section = null, type = null, item = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) { section = line.replace(/:.*$/, ''); type = null; item = null; continue; }
    if (section === 'component_types' && indent === 2 && /^[\w-]+:$/.test(line)) {
      type = { description: '', states: [] }; out.component_types[line.slice(0, -1)] = type; item = null; continue;
    }
    const target = section === 'component_types' ? type : section === 'screen_level_states' ? out.screen_level_states : null;
    if (!target) continue;
    const m = line.match(/^(-\s+)?([\w-]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1]) { item = {}; target.states.push(item); }
    if (m[2] === 'states') continue;
    if (!m[1] && item && indent >= (section === 'component_types' ? 8 : 6)) item[m[2]] = scalar(m[3]);
    else if (m[1]) item[m[2]] = scalar(m[3]);
    else if (m[2] === 'description') target.description = scalar(m[3]);
  }
  return out;
}

const taxonomy = () => parseTaxonomy(readFileSync(join(__dirname, 'states.yml'), 'utf8'));

// ---------------------------------------------------------------------------
// UI type detection (code) and matching (description)
// ---------------------------------------------------------------------------
const TYPE_RE = {
  form: /<form\b|\buseForm\(|\bonSubmit=|\bzodResolver\(|\bz\.object\(/,
  'data-table': /<table\b|<Table\b|<DataTable\b|<DataGrid\b|\buseReactTable\(|<TableRow\b|from ['"]react-data-grid['"]/,
  'file-upload': /type=["']file["']|\buseDropzone\(|<Dropzone\b|<\w*(Upload|Dropzone)\w*\b/,
  'modal-dialog': /<(Dialog|Modal|AlertDialog|Sheet|Drawer)\b/,
  search: /type=["']search["']|placeholder=["'][^"']*[Ss]earch|<\w*Search\w*(Input|Bar|Box)\b|\bsearchQuery\b|\bsetSearch\w*\(/,
  'notification-toast': /\btoast(\.\w+)?\(|\buseToast\(|<Toaster\b/,
  'toggle-switch': /<Switch\b|role=["']switch["']/,
  card: /<Card\b/,
  navigation: /<nav\b|<Sidebar\b|<NavLink\b|<Tabs\b|<Breadcrumb\b|<NavigationMenu\b/,
  'onboarding-flow': /\bStepper\b|\bcurrentStep\b|\bactiveStep\b|<Wizard\b|\bonboarding\b/i,
};

const DESC_RE = {
  'data-table': /\b(table|list|grid|rows?|records|dashboard)\b/i,
  form: /\b(form|sign ?up|sign ?in|log ?in|register|checkout|settings|edit|create|profile|input)\b/i,
  'file-upload': /\b(upload|attach|attachment|import|drop ?zone|file)\b/i,
  'modal-dialog': /\b(modal|dialog|popup|confirm|delete|bulk delete)\b/i,
  search: /\b(search|filters?|query|find)\b/i,
  'notification-toast': /\b(toast|notification|snackbar|alert)\b/i,
  'toggle-switch': /\b(toggle|switch)\b/i,
  card: /\b(cards?|tiles?)\b/i,
  navigation: /\b(nav|navigation|sidebar|menu|tabs|breadcrumb)\b/i,
  'onboarding-flow': /\b(onboarding|wizard|stepper|steps?|setup flow)\b/i,
};

// ---------------------------------------------------------------------------
// State signals. strong => handled, weak => doubtful. "renders" => handled when
// the UI type is present (default / loaded / hover / focus: the component draws it).
// Keys are "type.name" (checked first) or "name".
// ---------------------------------------------------------------------------
const RENDERS = new Set(['loaded', 'default', 'filling', 'focused', 'typing', 'results', 'off', 'on', 'off-hover', 'on-hover', 'step-active', 'active', 'info']);
const LOADING = /<Skeleton\b|\bisLoading\b|\bisPending\b|<Spinner\b|\bLoader2?\b|aria-busy|<Suspense\b[^>]*fallback|\bLoadingSpinner\b/;
const FETCH_ERR = /\b(isError|error)\s*(&&|\?\s*\(?\s*<)|if\s*\(\s*(isError|error)\b|<\w*Error\w*\b[^>]*(error|message)=/;
const EMPTY = /<EmptyState\b|\.length\s*===?\s*0|!\w+(\?\.)?\.length\s*(&&|\?)|\bNo \w+(\s\w+)? (found|yet)\b/;
const S = (strong, weak) => ({ strong, weak });

const SIGNALS = {
  'loading-initial': S(LOADING),
  'card.loading': S(LOADING),
  'modal-dialog.loading-content': S(LOADING),
  'loading-refresh': S(/\bisFetching\b|\bisRefetching\b|\bisValidating\b/, /\brefetch\b|\brevalidate/),
  empty: S(EMPTY),
  'empty-filtered': S(/[Cc]lear (all )?filters|\b(reset|clear)Filters\b|no \w+ match(es)? (your|the|these) filters?/i, EMPTY),
  'empty-search': S(/\bNo (results|matches)\b|[Nn]othing (found|matched)|no \w+ found for/i, EMPTY),
  'search.no-results': S(/\bNo (results|matches)\b|[Nn]othing (found|matched)|no \w+ found for/i, EMPTY),
  'error-fetch': S(FETCH_ERR, /\bonError\b|\bcatch\s*[({]|toast\.error/),
  'search.error': S(FETCH_ERR, /\bonError\b|\bcatch\s*[({]/),
  'card.error': S(FETCH_ERR, /\bonError\b|\bcatch\s*[({]/),
  'modal-dialog.error': S(FETCH_ERR, /\bonError\b|\bcatch\s*[({]|toast\.error|destructive/),
  'error-partial': S(/\bPromise\.allSettled\b|partial(ly)? (failed|loaded)/i),
  'permission-denied': S(/\b(403|[Ff]orbidden|[Aa]ccess denied|[Nn]o permission|[Uu]nauthori[sz]ed)\b/, /\bcan(Edit|View|Manage|Delete)\b|\bpermissions?\b/),
  offline: S(/navigator\.onLine|\buse(Is)?Online\b|\bisOnline\b|['"]offline['"]|\boffline\b/i),
  'pagination-loading': S(/\bisFetchingNextPage\b|\bfetchNextPage\b|\bloadMore\b/, /<Pagination\b|\bpagination\b/i),
  'bulk-selection': S(/\browSelection\b|\bgetSelectedRowModel\b|\bselected(Ids|Items|Rows)\b/, /\bselected\w*\b/),
  'field-error': S(/<FormMessage\b|\berrors\.\w+|fieldState\.error|aria-invalid|formState\.errors/, /\berror\b/),
  'field-success': S(/\bis(Available|Valid)\b.*<|CheckCircle/),
  submitting: S(/disabled=\{[^}]{0,60}\b(isSubmitting|isPending|isLoading|loading|submitting|pending|saving|isSaving)\b|<Button\b[^>]{0,200}\bloading=\{/, /\b(isSubmitting|isPending|isSaving)\b/),
  'submit-error': S(/\bonError\b|toast\.error|variant:\s*['"]destructive['"]|\bsetError\(|\bformError\b/, /\bcatch\s*[({]/),
  'submit-success': S(/\bonSuccess\b|toast\.success|\bnavigate\(|\bredirect\(|router\.(push|replace)\(/, /\.then\(/),
  'unsaved-changes': S(/beforeunload|\buseBlocker\(|\bunstable_usePrompt\(|[Uu]nsaved changes/, /\bisDirty\b/),
  'session-expired': S(/[Ss]ession (has )?(expired|timed out)|\b401\b/, /\b[Uu]nauthori[sz]ed\b|\bsignIn\(/),
  prefilled: S(/\bdefaultValues?\b/),
  'field-disabled': S(/\bdisabled(=\{|\s*\/?>|\s+\w+=)/),
  autosaving: S(/[Aa]uto-?sav|\bSaving…|\bSaving\.\.\./, /\bdebounce/i),
  'drag-hover': S(/\bonDrag(Over|Enter)\b|\bisDrag(Active|Accept)\b/),
  uploading: S(/\bonUploadProgress\b|<Progress\b|\bisUploading\b|\buploadProgress\b/, /\buploading\b/i),
  'upload-success': S(/\bonSuccess\b|[Uu]pload(ed)? (complete|successful)/),
  'error-too-large': S(/\bmaxSize\b|file\.size\s*>|too large|file-too-large|MAX_FILE_SIZE/i),
  'error-wrong-type': S(/file-invalid-type|[Ii]nvalid file type|[Uu]nsupported file/, /\baccept=/),
  'error-network': S(/\bonError\b|toast\.error/, /\bcatch\s*[({]/),
  'max-files-reached': S(/\bmaxFiles\b|too-many-files/),
  processing: S(/\bisProcessing\b|[Pp]rocessing/),
  replacing: S(/[Rr]eplace (file|document|image)|\bonReplace\b/, /\bremove\w*File\b/),
  confirmation: S(/<AlertDialog\b|[Aa]re you sure|\bconfirm\(/),
  'modal-dialog.submitting': S(/disabled=\{[^}]{0,60}\b(isSubmitting|isPending|isLoading|loading|submitting|pending)\b|<Button\b[^>]{0,200}\bloading=\{/, /\b(isSubmitting|isPending)\b/),
  'success-dismiss': S(/(setOpen|setIsOpen|onOpenChange)\(false\)|\bonClose\(\)/),
  collapsed: S(/\bisCollapsed\b|\bcollapsed\b|<SidebarTrigger\b/),
  mobile: S(/\b(sm|md|lg):(hidden|flex|block)\b|\buseMediaQuery\(|\bisMobile\b/),
  'notification-badge': S(/<Badge\b|\bunread\w*\b/i),
  'disabled-item': S(/aria-disabled|\bdisabled(=\{|\s*\/?>|\s+\w+=)/),
  overflow: S(/overflow-x-auto|<ScrollArea\b|<DropdownMenu\b/),
  'card.hover': S(/\bhover:/),
  selected: S(/aria-selected|\bisSelected\b|data-\[state=(checked|selected)\]/),
  expanded: S(/<Collapsible\b|aria-expanded|\bisExpanded\b|<Accordion\b/),
  'card.disabled': S(/\bdisabled\b|opacity-50/),
  'image-missing': S(/<AvatarFallback\b|\bonError=\{/),
  'result-highlight': S(/<mark\b|\bhighlight\w*\b/i),
  'notification-toast.success': S(/toast\.success|\btoast\(\{(?![^}]*destructive)[^}]*\b(title|description):|variant:\s*['"]success['"]|title:\s*_?\(?\s*(msg)?`?['"]?\w*\s*(Success|Saved|Sent|Created|Updated|Deleted)/),
  'notification-toast.warning': S(/toast\.warning|variant:\s*['"]warning['"]/),
  'notification-toast.error': S(/toast\.error|variant:\s*['"]destructive['"]/),
  'notification-toast.action': S(/<ToastAction\b|\baction:\s*[{<]/),
  persistent: S(/duration:\s*(Infinity|0\b)/),
  stacked: S(null, /<Toaster\b|\bsonner\b/),
  'toggle-switch.disabled-off': S(/<Switch\b[^>]*\bdisabled/),
  'toggle-switch.disabled-on': S(/<Switch\b[^>]*\bdisabled/),
  'toggle-switch.loading': S(/<Switch\b[^>]*\bdisabled=\{[^}]*(isPending|isLoading|loading)/, /\b(isPending|isLoading)\b/),
  'toggle-switch.error': S(/\bonError\b|toast\.error/, /\bcatch\s*[({]/),
  'step-completed': S(/\b(isComplete|completed|isDone)\b/),
  'step-upcoming': S(/\bstep\s*[<>]=?|\bcurrentStep\s*[<>]/),
  'step-skipped': S(/\bskip\w*\b/i),
  'completed-all': S(/\bonComplete\b|\bonFinish\b|\ballComplete\b/),
  'abandoned-return': S(/localStorage|\bpersist\b|\bresume\b/i),
  'error-in-step': S(/<FormMessage\b|\berrors\.\w+|\bonError\b/),
};

function signalFor(type, name) { return SIGNALS[`${type}.${name}`] || SIGNALS[name] || null; }

function snippet(f, idx) {
  const start = f.text.lastIndexOf('\n', idx) + 1;
  const end = f.text.indexOf('\n', idx);
  return f.text.slice(start, end < 0 ? undefined : end).trim().slice(0, 100);
}

// Find a regex in files; files holding this UI type are searched first.
function find(re, files, limit = 2) {
  const out = [];
  if (!re) return out;
  for (const f of files) {
    const idx = f.text.search(re);
    if (idx < 0) continue;
    out.push({ file: f.path, line: lineOf(f.text, idx), text: snippet(f, idx) });
    if (out.length >= limit) break;
  }
  return out;
}

function detectTypes(files) {
  const found = [];
  for (const [type, re] of Object.entries(TYPE_RE)) {
    for (const f of files) {
      if (!f.markup && !/\.(ts|js)$/.test(f.path)) continue;
      const idx = f.text.search(re);
      if (idx < 0) continue;
      found.push({ type, file: f.path, line: lineOf(f.text, idx), evidence: snippet(f, idx).slice(0, 80) });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------
function git(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); }
  catch { return null; }
}

const NON_UI = /(^|\/)(server|api|prisma|migrations|scripts|e2e|__tests__|tests?)(\/|\.|$)|\.server\.|\.(test|spec|stories)\./;

function defaultBase(repo, notes) {
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head && head[0]) return head[0];
  for (const b of ['main', 'master']) if (git(repo, ['rev-parse', '--verify', '--quiet', b])) return b;
  notes.push('No origin/HEAD, main or master branch found: comparing against HEAD~1 (the last commit). Pass --base to choose.');
  return 'HEAD~1';
}

function scopeFiles(repo, all, o, notes) {
  const byPath = new Map(all.map((f) => [f.path, f]));
  let entries = [];
  const named = new Set();
  const forced = new Set();
  let source;
  if (o.paths.length) {
    source = 'paths';
    for (const p of o.paths) {
      const rel = relative(repo, resolve(repo, p)).replaceAll('\\', '/');
      let isDir = false;
      try { isDir = statSync(resolve(repo, p)).isDirectory(); } catch {}
      if (isDir) entries.push(...all.filter((f) => f.path.startsWith(rel + '/')).map((f) => f.path));
      else if (byPath.has(rel)) { entries.push(rel); named.add(rel); }
    }
  } else {
    source = 'diff';
    if (!o.base) o.base = defaultBase(repo, notes);
    const diff = git(repo, ['diff', '--name-only', `${o.base}...HEAD`]);
    if (diff === null) throw new Error(`git diff against "${o.base}" failed in ${repo}. Pass --base <branch> or --paths.`);
    // git prints paths relative to the repo root; map to the walk root.
    const top = (git(repo, ['rev-parse', '--show-toplevel']) || [repo])[0];
    const changed = [...diff, ...(git(repo, ['diff', '--name-only', 'HEAD']) || []), ...(git(repo, ['ls-files', '--others', '--exclude-standard']) || [])];
    entries = changed.map((p) => relative(repo, resolve(top, p)).replaceAll('\\', '/'));
    entries.forEach((p) => named.add(p));
  }
  entries = [...new Set(entries)].filter((p) => byPath.has(p) && CODE_EXT.has(extname(p)) && !NON_UI.test(p));
  if (!entries.length) return { source, list: [], named, forced };
  // Follow imports a shallow depth; design-system files and app shells are covered by the inventory.
  // One extra hop, but only for files that hold actions (a thin component often
  // hands its submit/retry work to a queue or client module).
  const followed = featureFiles(repo, all, entries, Math.max(o.depth, 2))
    .filter(({ f, depth }) => depth <= o.depth || ACTION_FILE.test(basename(f.path)));
  const list = followed.filter(({ f, depth }) => depth === 0 || (!DS_DIR.test(dirname(f.path)) && !SHELL.test(f.path) && !NON_UI.test(f.path) && CODE_EXT.has(f.ext)));
  // --include: forced into scope, never dropped by the cap.
  for (const p of o.include || []) {
    const rel = relative(repo, resolve(repo, p)).replaceAll('\\', '/');
    const hits = all.filter((f) => f.path === rel || f.path.startsWith(rel + '/'));
    for (const f of hits) if (!list.some((x) => x.f.path === f.path)) list.push({ f, depth: 0 });
    hits.forEach((f) => forced.add(f.path));
  }
  return { source, list, named, forced };
}

// Relevance: files named explicitly (or changed) beat files found by expanding a
// folder; route/page files beat components; then how much UI and state logic a file holds; imports lose a point per hop.
const ROUTE = /(^|\/)(routes|pages)\/|(^|\/)(page|route)\.(tsx|jsx|vue|svelte)$|\+page\.svelte$/;

const ASYNC_CALL = /\b(mutateAsync|mutate|fetch|fetcher\.submit|submit)\s*\(|\baxios(\.\w+)?\(|\bawait\s+[\w.]+\(|\.useMutation\(|\buseMutation\(/;

const ACTION_FILE = /queue|retry|submit|api|client|mutation|action/i;
const ACTION_TEXT = /\b(mutateAsync|mutate|fetch|axios|fetcher\.submit|useMutation|retry\w*|enqueue|queue\w*|onSubmit|handleSubmit)\b|\bawait\s+[\w.]+\(/;
const LOW_PATH = /(^|\/)(types?|schemas?|constants?|config|i18n|locales?|translations?|emails?|mail|templates?\/emails?)(\/|\.|$)|\.(types|schema|d|config|constants)\.\w+$/i;

// Type/schema-only file: no JSX, no calls, mostly type/interface/zod declarations.
function declarationsOnly(f) {
  if (/<[A-Za-z][\w.]*[\s/>]/.test(f.text) && f.markup) return false;
  const lines = f.text.split('\n').filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*|import\b)/.test(l));
  const decl = lines.filter((l) => /^\s*(export\s+)?(type|interface|enum|declare)\b|\bz\.\w+\(|^\s*[\w?]+\s*:\s*[\w<\[|'"{]/.test(l)).length;
  return lines.length > 0 && decl / lines.length > 0.6;
}

function relevance(f, depth, named, routeDirs) {
  if (depth > 0 && (LOW_PATH.test(f.path) || declarationsOnly(f))) return -20;
  let r = (ACTION_TEXT.test(f.text) ? 3 : 0) + (ACTION_FILE.test(basename(f.path)) && ACTION_TEXT.test(f.text) ? 5 : 0) + (routeDirs.has(dirname(f.path)) ? 4 : 0) + (/(field|dialog)/i.test(basename(f.path)) && ASYNC_CALL.test(f.text) ? 3 : 0) + (named.has(f.path) ? 4 : depth === 0 ? 2 : 0) + (ROUTE.test(f.path) ? 3 : 0) + (/^(_?index|page|\[[^\]]+\])\.\w+$/.test(basename(f.path)) ? 2 : 0) + (/(page|view|screen)/i.test(basename(f.path)) && depth <= 1 ? 7 : 0) + (f.markup ? 1 : 0) - depth * 2;
  for (const re of Object.values(TYPE_RE)) if (re.test(f.text)) r++;
  for (const re of [LOADING, FETCH_ERR, EMPTY, /\bonError\b|toast\.error/, /\bdisabled=\{/]) if (re.test(f.text)) r++;
  return r;
}

function capLines(list, named, forced = new Set()) {
  // Sibling files of a named route file (complete.tsx, expired.tsx...) are states of the same page.
  const routeDirs = new Set([...named].filter((p) => ROUTE.test(p)).map((p) => dirname(p)));
  const scored = list.map(({ f, depth }) => ({ f, depth, lines: f.text.split('\n').length, rel: relevance(f, depth, named, routeDirs) }));
  // Near-duplicates (checkbox-field, date-field, name-field...): keep the best 3 of a family high, sink the rest.
  const fam = new Map();
  for (const x of [...scored].sort((a, b) => b.rel - a.rel || b.lines - a.lines)) {
    const m = basename(x.f.path).match(/[-_.]([a-z]+)\.\w+$/i) || basename(x.f.path).match(/([A-Z][a-z]+)\.\w+$/);
    if (!m) continue;
    const key = dirname(x.f.path) + '|' + m[1].toLowerCase();
    const n = (fam.get(key) || 0) + 1;
    fam.set(key, n);
    if (n > 3) x.rel -= 6;
  }
  const ranked = scored
    .sort((a, b) => b.rel - a.rel || a.lines - b.lines);
  const keep = [], dropped = [];
  let total = 0;
  for (const x of ranked) {
    if (forced.has(x.f.path) || total + x.lines <= MAX_LINES || !keep.length) { keep.push(x); total += x.lines; }
    else dropped.push({ path: x.f.path, lines: x.lines, depth: x.depth, reason: 'line cap' });
  }
  keep.sort((a, b) => a.depth - b.depth || a.f.path.localeCompare(b.f.path));
  return { keep, dropped, total };
}

// ---------------------------------------------------------------------------
// Inventory (cached, slimmed)
// ---------------------------------------------------------------------------
function loadInventory(repo, all) {
  const cachePath = join(__dirname, 'cache', `${slug(basename(repo))}-inventory.json`);
  let inv = null;
  if (existsSync(cachePath)) { try { inv = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {} }
  if (!inv) {
    inv = inventory(repo, all, scan(all), basename(repo));
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(inv, null, 2));
  }
  const comps = (inv.components || []).map((c) => {
    const variants = {};
    for (const v of c.variants || []) {
      const [g, val] = String(v.class || v).split('=');
      if (val) (variants[g] ||= []).push(val);
    }
    return { name: c.name, exports: c.exports || [], file: String(c.file || '').replace(/:\d.*$/, ''), variants };
  });
  return { ds_name: inv.project?.ds_name || inv.project?.ds_framework || inv.ds_name || null, components: comps, state_patterns: inv.state_patterns || {}, cache: relative(__dirname, cachePath) };
}

// ---------------------------------------------------------------------------
// Actions: the feature's own async work (sign, run, save, delete). Found from
// async call sites, named by the enclosing handler, with signals read from the
// ±30 lines around it and the JSX that triggers it.
// ---------------------------------------------------------------------------
const SIG = {
  pending: /\b(isPending|isLoading|isSubmitting|isSaving|isExecuting|isRunning|loading|pending|submitting|saving)\b|state\s*===\s*['"](submitting|loading)['"]/,
  error: /\bonError\b|\bcatch\b|\bisError\b|toast\.error|variant:\s*['"]destructive['"]|\bsetError\(/,
  disabled_while_pending: /disabled=\{[^}]{0,80}\b(isPending|isLoading|isSubmitting|isSaving|isExecuting|loading|pending|submitting|saving)\b|\bloading=\{/,
  confirm: /\bconfirm\(|<AlertDialog\b|[Aa]re you sure|Confirm\w*(Modal|Dialog)|\bconfirm\w*\b/,
  timeout_or_cancel: /\bAbortController\b|\babort\(|\bsignal:|\btimeout\b|\bcancel\w*\(/i,
};
const DESTRUCTIVE = /delete|drop|remove|reject|destroy|truncate|revoke|cancel/i;
const IMPORTANT = /sign|pay|charge|run|exec|submit|save|complete|verify|send|create|update|move|rename|upload|approve|finish/i;
const SKIP_AWAIT = /^(pMap|p\w+Map|revalidate|\w+\.revalidate|prisma\.[\w.]+|\w*FromRequest|router\.\w+|response\.\w+|res\.\w+|\w+\.(json|text|blob|arrayBuffer)|new|import|Promise|Promise\.\w+|queryClient\.\w+|form\.trigger|form\.handleSubmit|navigator\.\w+|sleep|wait|delay|setTimeout|console\.\w+|JSON\.\w+|Object\.\w+|this\.\w+)$/;

function actions(files) {
  const out = [];
  for (const f of files) {
    if (!/\.(tsx|jsx|ts|js|vue|svelte)$/.test(f.path)) continue;
    const lines = f.text.split('\n');
    const mutNames = new Set();
    for (const m of f.text.matchAll(/\bmutate(?:Async)?\s*:\s*(\w+)|const\s+(\w+)\s*=\s*[\w.]*use\w*Mutation\(/g)) mutNames.add(m[1] || m[2]);
    const seen = new Set();
    // Server-only sections of route files (Remix loader/action, Next getServerSideProps).
    const server = new Set();
    for (let i = 0, on = false; i < lines.length; i++) {
      if (/^(export\s+)?(async\s+)?(const|function)\s+(loader|action|meta|headers|getServerSideProps|getStaticProps|generateMetadata|\w+Loader|\w+Action)\b/.test(lines[i])) on = true;
      else if (/^(export|function|async\s+function|const|type|interface)\s/.test(lines[i])) on = false;
      if (on) server.add(i);
    }
    const re = /\b(mutateAsync|mutate|fetch|fetcher\.submit|submit|navigate)\s*\(|\baxios(?:\.\w+)?\(|\bawait\s+([\w.]+)\(|\b((?:api|client|service|sdk|http|supabase|db)\w*\.\w+)\s*\(|\b(\w+)\s*\(/g;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (server.has(i) || /^\s*(\/\/|\*|import\b)/.test(L)) continue;
      re.lastIndex = 0;
      let m, callee = null, kind = null;
      while ((m = re.exec(L))) {
        if (m[1]) { callee = m[1]; kind = m[1] === 'fetch' ? 'fetch' : /submit/.test(m[1]) ? 'submit' : m[1] === 'navigate' ? 'navigate' : 'mutation'; }
        else if (m[0].startsWith('axios')) { callee = 'axios'; kind = 'fetch'; }
        else if (m[2] && !SKIP_AWAIT.test(m[2])) { callee = m[2]; kind = mutNames.has(m[2]) || /mutat/i.test(m[2]) ? 'mutation' : /^(fetch|get|load|query|list)/i.test(m[2].split('.').pop()) ? 'fetch' : 'mutation'; }
        else if (m[3] && !/^(form|router|console|Object|JSON|Array|Math|z|document|window)\./.test(m[3])) { callee = m[3]; kind = /^(get|list|fetch|load)/i.test(m[3].split('.').pop()) ? 'fetch' : 'mutation'; }
        else if (m[4] && mutNames.has(m[4])) { callee = m[4]; kind = 'mutation'; }
        if (callee) break;
      }
      if (!callee || (kind === 'navigate' && !/await/.test(L))) continue;
      // Enclosing handler: nearest definition above.
      let name = null, defLine = i, trigger = 'unknown';
      for (let j = i; j >= Math.max(0, i - 40); j--) {
        const d = lines[j].match(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|(?:async\s+)?function\s+(\w+)|^\s*(on\w+|handle\w+)\s*[:=]\s*(?:async\s*)?\(|\b(useEffect)\(|\b(onSubmit|onClick)=\{/);
        if (d) { name = d[1] || d[2] || d[3] || d[4] || d[5]; defLine = j; break; }
      }
      if (!name || /^use[A-Z]/.test(name) && name !== 'useEffect') name = name || callee;
      if (name === 'useEffect') { trigger = 'effect'; name = `effect → ${callee}`; }
      const key = name + '|' + callee;
      if (seen.has(key) || seen.has(name)) continue;
      seen.add(key); seen.add(name);
      // Trigger + JSX that uses the handler.
      let jsx = '';
      if (trigger !== 'effect') {
        const use = f.text.search(new RegExp(`\\b(on[A-Z]\\w*|action|formAction)=\\{[^}]{0,60}\\b${name.replace(/[^\w]/g, '')}\\b`));
        if (use >= 0) {
          const t = f.text.slice(use).match(/^(on[A-Z]\w*|action|formAction)/)[1];
          trigger = t === 'onSubmit' || t === 'action' || t === 'formAction' ? 'onSubmit' : t;
          const tagStart = f.text.lastIndexOf('<', use);
          jsx = openTag(f.text, tagStart) + f.text.slice(use, use + 400);
        } else if (/submit/i.test(name + callee)) trigger = 'onSubmit';
      }
      if (/submit/i.test(name) && kind === 'mutation' && trigger === 'onSubmit') kind = 'submit';
      const win = lines.slice(Math.max(0, defLine - 30), i + 30).join('\n') + '\n' + jsx;
      const signals = Object.fromEntries(Object.entries(SIG).map(([k, r]) => [k, r.test(win)]));
      const label = `${name} ${callee}`;
      const rank = (DESTRUCTIVE.test(label) ? 6 : 0) + (IMPORTANT.test(label) ? 3 : 0) + (kind === 'mutation' || kind === 'submit' ? 2 : 0) + (trigger !== 'effect' ? 1 : 0) + (f.markup ? 1 : 0);
      // A call whose promise nobody waits for: success UI can run before (or despite) failure.
      const unawaited = !/\b(await|return|then\(|mutate\w*\(|=>\s*\w)/.test(L) && /\.\w+\(/.test(callee + '(') && kind !== 'navigate' && !mutNames.has(callee) && !/^(mutate|mutateAsync|submit|fetcher\.submit)$/.test(callee);
      out.push({ name: name === callee ? name : `${name} → ${callee}`, at: `${f.path}:${defLine + 1}`, kind, trigger, signals, ...(unawaited ? { unawaited: `${f.path.split('/').pop()}:${i + 1}` } : {}), rank });
    }
  }
  // Same handler → same call in many files (one per field type): one entry, with a count.
  const groups = new Map();
  for (const a of out) {
    const g = groups.get(a.name);
    if (g) { g.also = (g.also || 0) + 1; for (const k in a.signals) g.signals[k] = g.signals[k] && a.signals[k]; }
    else groups.set(a.name, a);
  }
  return [...groups.values()].sort((a, b) => b.rank - a.rank).slice(0, 16).map(({ rank, also, ...a }) => (also ? { ...a, also_in: also } : a));
}

// Guards: validation or allowlists that gate dangerous actions.
function guards(files) {
  const out = [];
  const re = /\b(isDestructive|destructive\w*|dangerous\w*|allow ?list|whitelist|blocklist|deny ?list|confirm\w*Delete|requires?Confirm\w*)\b/i;
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((L, i) => {
      if (out.length >= 5 || DS_DIR.test(dirname(f.path)) || /^\s*(\/\/|\*|import\b)/.test(L) || /variant[=:]\s*\{?['"]destructive|className|\b(text|bg|border)-destructive|hsl\(|'destructive'\s*[|;]/.test(L)) return;
      const near = lines.slice(Math.max(0, i - 5), i + 5).join('\n');
      if (re.test(L) || (/\/(?![/*])(?:\\.|[^/\n])+\/[gimsuy]*\.test\(|new RegExp\(/.test(L) && /delete|drop|truncate|destructive|alter/i.test(near))) {
        out.push({ at: `${f.path}:${i + 1}`, text: L.trim().slice(0, 100) });
      }
    });
  }
  return out.slice(0, 5);
}

// Accessibility hints the regexes can see with confidence.
function a11y(files) {
  const out = [];
  for (const f of files) {
    if (!f.markup) continue;
    for (const m of f.text.matchAll(/<(div|span|li|img|td|tr)\b/g)) {
      const tag = openTag(f.text, m.index);
      if (/\bonClick=/.test(tag) && !/\brole=|\btabIndex=|\bonKeyDown=|\bonKeyUp=/.test(tag)) out.push({ at: `${f.path}:${lineOf(f.text, m.index)}`, issue: `clickable <${m[1]}> without role/tabIndex/keyboard handler` });
    }
    const c = f.text.search(/<canvas\b|react-konva|<Stage\b/);
    if (c >= 0 && !/\bonKeyDown\b|\bonKeyUp\b|useHotkeys/.test(f.text)) out.push({ at: `${f.path}:${lineOf(f.text, c)}`, issue: 'canvas without a keyboard alternative' });
    for (const m of f.text.matchAll(/<(button|Button)\b/g)) {
      const tag = openTag(f.text, m.index);
      if (/aria-label|aria-labelledby|\btitle=|\/>$/.test(tag)) continue;
      const end = f.text.indexOf(`</${m[1]}>`, m.index + tag.length);
      if (end < 0 || end - m.index > 1500) continue;
      const inner = f.text.slice(m.index + tag.length, end);
      const text = inner.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, (x) => /_\(|t`|msg`|Trans|label|text|children|title/i.test(x) ? 'T' : '').trim();
      if (!text && /<\w*(Icon|Svg|svg)\b|<[A-Z]\w*\s+className=/.test(inner)) out.push({ at: `${f.path}:${lineOf(f.text, m.index)}`, issue: 'icon-only button without aria-label' });
    }
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
function check(repo, o) {
  const t0 = performance.now();
  const all = walk(repo, repo, []);
  const notes = [];
  const { source, list, named, forced } = scopeFiles(repo, all, o, notes);
  const { keep, dropped, total } = capLines(list, named, forced);
  const files = keep.map((x) => x.f);
  const tax = taxonomy();

  const ui_types = detectTypes(files);
  const types = [...new Set(ui_types.map((u) => u.type))];
  const states = [];
  for (const type of types) {
    const def = tax.component_types[type];
    if (!def) continue;
    const typeFiles = new Set(ui_types.filter((u) => u.type === type).map((u) => u.file));
    const own = files.filter((f) => typeFiles.has(f.path));
    const others = files.filter((f) => !typeFiles.has(f.path));
    const first = ui_types.find((u) => u.type === type);
    for (const st of def.states) {
      const name = String(st.name);
      const base = { id: `${type}.${name}`, type, name, description: st.description || '', required: st.required === true, ds_hint: st.ds_hint || '' };
      const sig = signalFor(type, name);
      let status, evidence = [];
      if (RENDERS.has(name) && !sig) {
        status = 'handled'; evidence = [{ file: first.file, line: first.line, text: first.evidence }];
      } else if (sig && (evidence = find(sig.strong, own)).length) {
        status = 'handled';
      } else if (sig && ((evidence = find(sig.weak, own)).length || (evidence = find(sig.strong, others)).length)) {
        // Weak signal, or a strong one only in files that don't render this UI type.
        status = 'doubtful';
      } else {
        evidence = [];
        status = base.required ? 'doubtful' : 'no_signal';
      }
      states.push({ ...base, status, evidence });
    }
  }

  // Screen-level: judged on the files that render UI. A pattern found only in
  // hooks or helpers doesn't prove the screen shows it.
  const uiSet = new Set(ui_types.map((u) => u.file));
  const uiFiles = files.filter((f) => uiSet.has(f.path));
  const screen_level = [];
  if (uiFiles.length) {
    const resUi = scan(uiFiles);
    const resAll = scan(files);
    resUi.results.forEach((r, i) => {
      const a = resAll.results[i];
      const required = r.weight >= 3;
      const problems = r.problems.filter((p) => p.count).map((p) => ({ label: p.label, count: p.count, samples: p.samples.map((x) => ({ file: x.path, line: x.line })) }));
      const ev = (res) => res.signals.filter((s) => s.files).flatMap((s) => s.samples.slice(0, 1).map((x) => ({ file: x.path, line: x.line, text: s.label }))).slice(0, 3);
      let status, evidence = ev(r);
      if (r.status === 'handled') status = 'handled';
      else if (r.status === 'partial') status = 'doubtful';
      else if (a.status !== 'missing') {
        status = 'doubtful'; evidence = ev(a);
        for (const e of evidence) problems.push({ label: `pattern only in ${e.file}`, count: 1, samples: [{ file: e.file, line: e.line }] });
      } else status = required ? 'doubtful' : 'no_signal';
      screen_level.push({ id: `screen.${r.id}`, name: r.name, required, hurts: r.hurts, status, evidence, problems });
    });
  }

  const inv = loadInventory(repo, all);
  const to_check = states.filter((s) => s.status === 'doubtful').length + screen_level.filter((s) => s.status === 'doubtful').length;
  const stats = { files: keep.length, lines: total, states_total: states.length + screen_level.length, to_check, ms: Math.round(performance.now() - t0) };
  const scopeOut = { source, base: source === 'diff' ? o.base : null, files: keep.map((x) => ({ path: x.f.path, lines: x.lines, depth: x.depth })), dropped, ...(notes.length ? { notes } : {}) };
  const acts = actions(files);
  const guardList = guards(files);
  const a11yList = a11y(files);
  if (o.verbose) {
    return { mode: 'check', repo, scope: scopeOut, actions: acts, guards: guardList, a11y: a11yList, inventory: { ds_name: inv.ds_name, components: inv.components.map(({ exports, ...c }) => c), state_patterns: inv.state_patterns }, ui_types, states, screen_level, stats };
  }

  // Compact output (default): handled states as one-line pointers, full entries only for the rest.
  const at = (e) => (e ? `${e.file}:${e.line}` : null);
  const handled = [...states, ...screen_level].filter((s) => s.status === 'handled').map((s) => ({ id: s.id, at: at(s.evidence[0]) }));
  const slim = (s) => { const { status, evidence, problems, hurts, ...rest } = s; return { ...rest, status, evidence: evidence.slice(0, 1).map((e) => ({ ...e, text: (e.text || '').slice(0, 60) })), ...(problems && problems.length ? { problems: problems.map((p) => `${p.label}${p.count > 1 ? ` (${p.count})` : ''}${p.samples[0] && !p.label.includes(p.samples[0].file) ? ` @ ${p.samples[0].file}:${p.samples[0].line}` : ''}`) } : {}) }; };
  // Inventory: components the scope imports, plus the ones that draw states.
  const imported = new Set();
  for (const f of files) for (const m of f.text.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}|import\s+([A-Z]\w*)/g)) {
    for (const n of (m[1] || m[2]).split(',')) { const x = n.trim().split(/\s+as\s+/)[0].trim(); if (x) imported.add(x); }
  }
  const norm = (n) => n.toLowerCase().replace(/[^a-z]/g, '');
  const STATE_DS = /^(alert|alertdialog|banner|skeleton|spinner|loader|toast|toaster|sonner|usetoast|dialog|emptystate|empty|button|progress|tooltip)$/;
  const components = inv.components
    .filter((c) => STATE_DS.test(norm(c.name)) || c.exports.some((e) => imported.has(e)))
    .map((c) => ({ name: c.name, file: c.file, ...(/^(button|alert|badge)$/.test(norm(c.name)) && Object.keys(c.variants).length ? { variants: c.variants } : {}) }));
  const state_patterns = Object.fromEntries(Object.entries(inv.state_patterns).map(([k, v]) => [k, [...new Set(v.map((p) => `${p.type || p.component || p.pattern || p.name || k} @ ${String(p.file || '').replace(/:\d.*$/, '')}`))].slice(0, 3)]));
  const typesOut = [];
  for (const u of ui_types) if (!typesOut.some((t) => t.type === u.type)) typesOut.push({ ...u, evidence: u.evidence.slice(0, 60), files: ui_types.filter((x) => x.type === u.type).length });
  return {
    mode: 'check', repo,
    scope: { ...scopeOut, files: Object.fromEntries([...new Set(scopeOut.files.map((f) => f.depth))].map((d) => [`depth${d}`, scopeOut.files.filter((f) => f.depth === d).map((f) => `${f.path}:${f.lines}`)])), dropped: { count: dropped.length, lines: dropped.reduce((n, d) => n + d.lines, 0), top: dropped.slice(0, 5).map((d) => d.path) } },
    inventory: { ds_name: inv.ds_name, components, state_patterns },
    ui_types: typesOut,
    actions: acts,
    guards: guardList,
    a11y: a11yList,
    handled,
    no_signal: [...states, ...screen_level].filter((s) => s.status === 'no_signal').map((s) => s.id),
    states: states.filter((s) => s.status === 'doubtful').map(slim),
    screen_level: screen_level.filter((s) => s.status === 'doubtful').map(slim),
    stats,
  };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------
function plan(feature, o) {
  const tax = taxonomy();
  const ui_types = [];
  for (const [type, re] of Object.entries(DESC_RE)) {
    const m = feature.match(re);
    if (m) ui_types.push({ type, why: `matched '${m[0]}'` });
  }
  const states = ui_types.flatMap(({ type }) => (tax.component_types[type]?.states || []).map((st) => ({
    id: `${type}.${st.name}`, type, name: String(st.name), description: st.description || '', required: st.required === true, ds_hint: st.ds_hint || '',
  })));
  const screen_level = tax.screen_level_states.states.map((st) => ({ id: `screen.${st.name}`, name: st.name, description: st.description || '', ds_hint: st.ds_hint || '' }));
  let components = [];
  if (o.repo) {
    const repo = resolve(o.repo);
    const cache = join(__dirname, 'cache', `${slug(basename(repo))}-inventory.json`);
    const inv = loadInventory(repo, existsSync(cache) ? [] : walk(repo, repo, []));
    components = inv.components.map(({ name, file }) => ({ name, file }));
  }
  return { mode: 'plan', feature, ui_types, states, screen_level, components };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function flags(argv) {
  const o = { base: null, paths: [], include: [], depth: 1, positional: [] };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--paths') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.paths.push(argv[++i]); }
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--depth') o.depth = Number(argv[++i]);
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--include') o.include.push(argv[++i]);
    else o.positional.push(a);
  }
  return o;
}

// One top-level key per line, one array item per line: readable, and far smaller than indent 2.
function compactJson(obj) {
  const val = (v) => Array.isArray(v) ? (v.length ? `[\n    ${v.map((x) => JSON.stringify(x)).join(',\n    ')}\n  ]` : '[]') : JSON.stringify(v);
  const obj2 = (v) => v && typeof v === 'object' && !Array.isArray(v)
    ? `{\n${Object.entries(v).map(([k, x]) => `    ${JSON.stringify(k)}: ${Array.isArray(x) ? JSON.stringify(x) : JSON.stringify(x)}`).join(',\n')}\n  }` : val(v);
  return `{\n${Object.entries(obj).map(([k, v]) => `  ${JSON.stringify(k)}: ${obj2(v)}`).join(',\n')}\n}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const USAGE = 'Usage:\n  node states-scan.mjs check <repo> [--base <branch>] [--paths a b ...] [--depth 1] [--include <path> ...] [--out scope.json] [--verbose]\n  node states-scan.mjs plan "<feature>" [--repo <repo>] [--out plan.json]';
  try {
    const mode = process.argv[2];
    const o = flags(process.argv);
    let out, summary;
    if (mode === 'check') {
      const repo = o.positional[0] && resolve(o.positional[0]);
      if (!repo || !existsSync(repo)) throw new Error(USAGE);
      out = check(repo, o);
      const c = (st) => out.states.filter((s) => s.status === st).length + out.screen_level.filter((s) => s.status === st).length;
      summary = [
        `${basename(repo)}: ${out.stats.files} files, ${out.stats.lines} lines (${out.scope.source}${(out.scope.dropped.count ?? out.scope.dropped.length) ? `, ${out.scope.dropped.count ?? out.scope.dropped.length} dropped by line cap` : ''})`,
        `UI types: ${[...new Set(out.ui_types.map((u) => u.type))].join(', ') || 'none found'}`,
        `States: ${out.stats.states_total} — ${out.handled ? out.handled.length : c('handled')} handled, ${c('doubtful')} doubtful (to check), ${out.no_signal ? out.no_signal.length : c('no_signal')} no signal  [${out.stats.ms} ms]`,
      ].join('\n');
      if (!out.stats.files) summary += '\nNo UI files in scope. Pass --paths or a different --base.';
    } else if (mode === 'plan') {
      const feature = o.positional.join(' ').trim();
      if (!feature) throw new Error(USAGE);
      out = plan(feature, o);
      summary = `Plan: ${out.ui_types.map((u) => u.type).join(', ') || 'no UI types matched'} — ${out.states.length} states (${out.states.filter((s) => s.required).length} required) + ${out.screen_level.length} screen-level${out.components.length ? `, ${out.components.length} DS components` : ''}`;
    } else throw new Error(USAGE);
    if (o.out) {
      mkdirSync(dirname(resolve(o.out)), { recursive: true });
      writeFileSync(resolve(o.out), o.verbose || mode === 'plan' ? JSON.stringify(out, null, 2) : compactJson(out));
      console.log(summary + `\nWrote ${o.out}`);
    } else {
      console.error(summary);
      console.log(JSON.stringify(out, null, 2));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
