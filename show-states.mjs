#!/usr/bin/env node

// show-states.mjs — plays /states "show" recipes (skill/prompts/show.md) in a real
// browser and screenshots each state.
//
// Usage:
//   node show-states.mjs <recipes.json> --base http://localhost:5179 --out <dir> --label before|after
//        [--only F1,F4]     run only these recipe ids
//        [--headed]         show the browser
//
// Writes <dir>/<id>-<label>.png (plus <id>-<label>-<shot>.png for `shot` steps)
// and <dir>/shots-<label>.json: { "<id>": { file, ok, error?, extra? } }.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

function flag(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
}

const recipesPath = process.argv[2];
if (!recipesPath || recipesPath.startsWith('--')) {
  console.error('Usage: node show-states.mjs <recipes.json> --base <url> --out <dir> --label before|after');
  process.exit(1);
}
const input = JSON.parse(readFileSync(resolve(recipesPath), 'utf8'));
const base = (flag('--base') || input.base_url || 'http://localhost:5173').replace(/\/$/, '');
const outDir = resolve(flag('--out', '.'));
const label = flag('--label', 'before');
const only = flag('--only') ? new Set(flag('--only').split(',')) : null;
const RECIPE_TIMEOUT = 20000;

// Resolve playwright from the project, then from the npx cache (npx playwright ...).
async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const { readdirSync, existsSync } = await import('fs');
  const { homedir } = await import('os');
  const { pathToFileURL } = await import('url');
  const npx = join(homedir(), '.npm', '_npx');
  const hits = existsSync(npx) ? readdirSync(npx).map((d) => join(npx, d, 'node_modules', 'playwright', 'index.mjs')).filter(existsSync) : [];
  let fallback = null;
  for (const h of hits) {
    try {
      const pw = await import(pathToFileURL(h).href);
      // Prefer a cached copy whose browser is already downloaded.
      if (existsSync(pw.chromium.executablePath())) return pw;
      fallback ??= pw;
    } catch {}
  }
  if (fallback) return fallback;
  throw new Error('not found');
}

let chromium;
try {
  ({ chromium } = await loadPlaywright());
} catch {
  console.error('Playwright is not installed. Run:\n  npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

function abs(url) { return /^https?:/.test(url) ? url : base + (url.startsWith('/') ? url : '/' + url); }

async function installNetwork(context, rules = []) {
  for (const rule of rules) {
    let used = false;
    await context.route((u) => u.href.includes(rule.match), async (route) => {
      const req = route.request();
      if ((rule.method && req.method() !== rule.method.toUpperCase()) || (rule.once && used)) return route.fallback();
      used = true;
      if (rule.delay) await new Promise((r) => setTimeout(r, rule.delay));
      if (rule.abort) return route.abort('internetdisconnected');
      if (rule.respond) {
        const { status = 200, body, headers, contentType } = rule.respond;
        return route.fulfill({
          status,
          headers,
          contentType: contentType || (typeof body === 'string' ? 'text/plain' : 'application/json'),
          body: body === undefined ? (status >= 400 ? JSON.stringify({ message: `HTTP ${status}` }) : '') : typeof body === 'string' ? body : JSON.stringify(body),
        });
      }
      return route.fallback();
    });
  }
}

async function outlineFocus(page) {
  await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return;
    el.style.setProperty('outline', '3px solid #e11d48', 'important');
    el.style.setProperty('outline-offset', '2px', 'important');
  });
}

async function capture(page, cap, file) {
  if (cap?.focus) await outlineFocus(page);
  if (cap?.clip) {
    await page.screenshot({ path: file, clip: cap.clip });
  } else if (!cap || cap === 'page' || cap.page || !cap.selector) {
    await page.screenshot({ path: file });
  } else {
    await page.locator(cap.selector).first().screenshot({ path: file, timeout: 5000 });
  }
}

async function runRecipe(browser, r) {
  const context = await browser.newContext({ viewport: r.viewport || { width: 1280, height: 800 } });
  context.setDefaultTimeout(8000);
  const extra = {};
  try {
    await installNetwork(context, r.network);
    const page = await context.newPage();
    await page.goto(abs(r.url || '/'), { waitUntil: 'domcontentloaded' });
    if (r.offline) await context.setOffline(true);
    for (const s of r.steps || []) {
      const t = s.timeout ? { timeout: s.timeout } : {};
      if (s.click) await page.locator(s.click).first().click(t);
      else if (s.dblclick) await page.locator(s.dblclick).first().dblclick(t);
      else if (s.fill) await page.locator(s.fill).first().fill(String(s.value ?? ''), t);
      else if (s.press) await page.keyboard.press(s.press);
      else if (s.select) await page.locator(s.select).first().selectOption(String(s.value), t);
      else if (s.upload) {
        // { upload: "<input[type=file] selector>", file: { name, size?, mimeType? } } — a generated file of that size
        const f = s.file || {};
        const buffer = Buffer.alloc(Math.min(f.size ?? 1024, 50 * 1024 * 1024), 0x41);
        await page.locator(s.upload).first().setInputFiles({ name: f.name || 'file.bin', mimeType: f.mimeType || 'application/octet-stream', buffer });
      }
      else if (s.goto) await page.goto(abs(s.goto), { waitUntil: 'domcontentloaded' });
      else if ('offline' in s) await context.setOffline(!!s.offline);
      else if ('wait' in s) {
        if (typeof s.wait === 'number') await page.waitForTimeout(s.wait);
        // Waits for text usually describe the broken state. After a fix that text is gone,
        // so in the "after" run a missed wait just lets the page settle and moves on.
        else if (label === 'after') {
          try { await page.locator(s.wait).first().waitFor({ state: 'visible', timeout: 3000 }); }
          catch { await page.waitForTimeout(1500); }
        }
        else await page.locator(s.wait).first().waitFor({ state: 'visible', ...t });
      } else if (s.shot) {
        const f = `${r.id}-${label}-${s.shot}.png`;
        await capture(page, s.capture || r.capture, join(outDir, f));
        extra[s.shot] = f;
      }
    }
    const file = `${r.id}-${label}.png`;
    await capture(page, r.capture, join(outDir, file));
    return { file, ok: true, ...(Object.keys(extra).length ? { extra } : {}) };
  } finally {
    await context.close().catch(() => {});
  }
}

const headless = !process.argv.includes('--headed');
let browser;
try {
  browser = await chromium.launch({ headless });
} catch (e) {
  // No bundled browser: fall back to an installed Chrome before giving up.
  try { browser = await chromium.launch({ headless, channel: 'chrome' }); }
  catch { console.error(`Could not start Chromium: ${String(e.message).split('\n')[0]}\nRun: npx playwright install chromium`); process.exit(1); }
}
const results = {};
for (const r of input.recipes || []) {
  if (only && !only.has(r.id)) continue;
  if (r.skip) { results[r.id] = { file: null, ok: false, error: `skipped: ${r.skip}` }; console.error(`${r.id}: skipped (${r.skip})`); continue; }
  try {
    let timer;
    results[r.id] = await Promise.race([
      runRecipe(browser, r),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${RECIPE_TIMEOUT / 1000}s`)), RECIPE_TIMEOUT); }),
    ]).finally(() => clearTimeout(timer));
    console.error(`${r.id}: ok ${results[r.id].file}`);
  } catch (e) {
    results[r.id] = { file: null, ok: false, error: String(e.message || e).split('\n')[0] };
    console.error(`${r.id}: FAILED ${results[r.id].error}`);
  }
}
await browser.close();
const manifest = join(outDir, `shots-${label}.json`);
writeFileSync(manifest, JSON.stringify(results, null, 2));
console.error(`wrote ${manifest}`);
