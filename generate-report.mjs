#!/usr/bin/env node

// generate-report.mjs — Converts auditor JSON + DS inventory into an HTML report.
// Replaces the Report Builder agent. Runs in <1 second.
//
// Usage: node generate-report.mjs <auditor-json> <inventory-json> [--tier2 id1,id2,id3]
//
// Or: called by the orchestrator with JSON piped to stdin:
//   echo '{"auditor": {...}, "inventory": {...}, "meta": {...}, "tier2": [87,86]}' | node generate-report.mjs

import { readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadInput() {
  // Try stdin first (piped JSON)
  if (!process.stdin.isTTY) {
    const chunks = [];
    const fd = openSync('/dev/stdin', 'r');
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = readSync(fd, buf)) > 0) chunks.push(buf.slice(0, n));
    closeSync(fd);
    return JSON.parse(Buffer.concat(chunks).toString());
  }

  // CLI args: generate-report.mjs <auditor.json> <inventory.json>
  const [auditorPath, inventoryPath] = process.argv.slice(2);
  if (!auditorPath) {
    console.error('Usage: node generate-report.mjs <auditor.json> [inventory.json] [--tier2 id1,id2]');
    process.exit(1);
  }

  const auditor = JSON.parse(readFileSync(resolve(auditorPath), 'utf8'));
  const inventory = inventoryPath ? JSON.parse(readFileSync(resolve(inventoryPath), 'utf8')) : null;

  const tier2Flag = process.argv.indexOf('--tier2');
  const tier2 = tier2Flag > -1 ? process.argv[tier2Flag + 1].split(',').map(Number) : [];

  return { auditor, inventory, tier2 };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badge(status) {
  const cls = { covered: 'badge-covered', partial: 'badge-partial', gap: 'badge-gap', recommendation: 'badge-rec' }[status] || 'badge-gap';
  const label = status === 'recommendation' ? 'Rec' : status.charAt(0).toUpperCase() + status.slice(1);
  return `<span class="badge ${cls}">${label}</span>`;
}


function buildMatrixRows(coverage) {
  const gaps = coverage.filter(c => c.status === 'gap');
  const partial = coverage.filter(c => c.status === 'partial');
  const recs = coverage.filter(c => c.status === 'recommendation');
  const covered = coverage.filter(c => c.status === 'covered');
  let html = '';

  if (gaps.length) {
    html += `<tr><td colspan="5" class="section-divider section-divider-gap">Gaps &mdash; ${gaps.length} states need work</td></tr>\n`;
    gaps.forEach(c => { html += matrixRow(c); });
  }
  if (partial.length) {
    html += `<tr><td colspan="5" class="section-divider section-divider-partial">Partial &mdash; ${partial.length} states have building blocks</td></tr>\n`;
    partial.forEach(c => { html += matrixRow(c); });
  }
  if (recs.length) {
    html += `<tr><td colspan="5" class="section-divider section-divider-rec">Recommendations &mdash; ${recs.length} nice-to-have improvements</td></tr>\n`;
    recs.forEach(c => { html += matrixRow(c); });
  }
  if (covered.length) {
    html += `<tr><td colspan="5" class="section-divider section-divider-covered">Covered &mdash; ${covered.length} states with DS patterns</td></tr>\n`;
    covered.forEach(c => { html += coveredRow(c); });
  }

  return html;
}

function matrixRow(c) {
  const isExpandable = c.status !== 'covered';
  const onclick = isExpandable ? ' class="expandable" onclick="toggleDetail(this)"' : '';
  let html = `<tr${onclick}>
  <td><div class="state-name">${escapeHtml(c.name)}</div><div class="state-component">${escapeHtml(c.component || 'screen-level')}</div></td>
  <td class="state-description">${escapeHtml(c.description || '')}</td>
  <td>${c.required ? '<span class="badge badge-required">Required</span>' : ''}</td>
  <td>${badge(c.status)}</td>
  <td class="file-ref">${escapeHtml(c.evidence || '')}</td>
</tr>\n`;

  if (isExpandable) {
    html += `<tr class="state-detail"><td colspan="5"><div class="state-detail-inner">
  <div class="suggestion suggestion-${c.status}"><strong>${c.priority === 'critical' ? 'Critical' : 'Nice-to-have'}.</strong> ${escapeHtml(c.gap_label || c.notes || '')}</div>
  ${c.tier2_html || ''}
  <div class="detail-notes">
    <div class="note-group"><h4>Extend From</h4><ul>${(c.extends_from || []).map(e => `<li><code>${escapeHtml(e)}</code></li>`).join('')}</ul></div>
    <div class="note-group"><h4>Implementation</h4><ul>${(c.implementation || []).map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>
  </div>
</div></td></tr>\n`;
  }
  return html;
}

function coveredRow(c) {
  return `<tr>
  <td><div class="state-name">${escapeHtml(c.name)}</div><div class="state-component">${escapeHtml(c.component || '')}</div></td>
  <td class="state-description">${escapeHtml(c.description || '')}</td>
  <td>${c.required ? '<span class="badge badge-required">Required</span>' : ''}</td>
  <td>${badge('covered')}</td>
  <td class="file-ref">${escapeHtml(c.evidence || '')}</td>
</tr>\n`;
}

function generateReport(data) {
  const { auditor, inventory, meta = {}, tier2 = [] } = data;
  const coverage = auditor.coverage || [];
  const summary = auditor.summary || {};

  const feature = meta.feature || 'Feature';
  const description = meta.description || '';
  const dsName = meta.ds_name || (inventory?.project?.ds_name) || 'Design System';
  const projectPath = meta.project_path || (inventory?.project?.path) || '';
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Read DS tokens CSS from inventory if available
  let dsTokensCss = '';
  if (inventory?.tokens) {
    const colors = (inventory.tokens.colors || [])
      .filter(t => t.name && t.value && !t.value.startsWith('var('))
      .map(t => `--ft-${t.name.replace(/^--/, '')}: ${t.value};`)
      .join('\n    ');
    if (colors) dsTokensCss = `\n  .mockup-frame {\n    ${colors}\n  }`;
  }

  const rows = buildMatrixRows(coverage);

  const total = summary.total || coverage.length;
  const gaps = summary.gap || coverage.filter(c => c.status === 'gap').length;
  const partial = summary.partial || coverage.filter(c => c.status === 'partial').length;
  const recs = summary.recommendation || coverage.filter(c => c.status === 'recommendation').length;
  const covered = summary.covered || coverage.filter(c => c.status === 'covered').length;
  const scored = covered + partial + gaps;
  const pct = scored > 0 ? ((covered / scored) * 100).toFixed(1) : '0';

  const templatePath = resolve(__dirname, 'templates', 'report-chrome.css');
  const chromeCss = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : DEFAULT_CSS;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>State Report &mdash; ${escapeHtml(feature)}</title>
<style>
${chromeCss}
${dsTokensCss}
</style>
</head>
<body>
<div class="report">

  <header class="report-header">
    <h1>${escapeHtml(feature)}</h1>
    <div class="report-meta">
      <span>Generated ${date}</span>
      <span>&middot;</span>
      <span>Design system: ${escapeHtml(dsName)}</span>
      ${projectPath ? `<span>&middot;</span><span>Source: ${escapeHtml(projectPath)}</span>` : ''}
    </div>
    ${description ? `<p class="report-description">${escapeHtml(description)}</p>` : ''}
  </header>

  <div class="stats-bar">
    <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total States</div></div>
    <div class="stat-card stat-gaps"><div class="stat-value">${gaps}</div><div class="stat-label">Gaps</div></div>
    <div class="stat-card stat-partial"><div class="stat-value">${partial}</div><div class="stat-label">Partial</div></div>
    <div class="stat-card stat-covered"><div class="stat-value">${covered}</div><div class="stat-label">Covered</div></div>
  </div>

  <div class="section">
    <h2 class="section-title">State Coverage Matrix</h2>
    <table class="matrix">
      <thead><tr>
        <th style="width:22%">State</th>
        <th style="width:22%">Description</th>
        <th style="width:9%">Required</th>
        <th style="width:9%">Status</th>
        <th style="width:38%">Evidence</th>
      </tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>

  <footer class="report-footer">
    <span>DS State Gen &mdash; Multi-Agent Coverage Pipeline</span>
    <span>${gaps} gaps &middot; ${partial} partial &middot; ${covered} covered &mdash; ${pct}% coverage</span>
  </footer>

</div>
<script>
function toggleDetail(row) {
  row.classList.toggle('open');
  const detail = row.nextElementSibling;
  if (detail && detail.classList.contains('state-detail')) detail.classList.toggle('open');
}
</script>
</body>
</html>`;
}

const DEFAULT_CSS = `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --report-font: 'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --report-bg: #f8f8f6; --report-surface: #ffffff; --report-text: #1a1a1a;
  --report-text-secondary: #6b6b6b; --report-text-tertiary: #999999;
  --report-border: #e5e5e5; --report-border-light: #f0f0f0;
  --report-radius: 10px; --report-radius-sm: 6px;
  --status-covered: #2a7d4f; --status-covered-bg: #e8f5ec;
  --status-partial: #b8860b; --status-partial-bg: #fef9e7;
  --status-gap: #c0392b; --status-gap-bg: #fdecea;
  --status-rec: #445468; --status-rec-bg: #E2E8EE;
}
body { font-family: var(--report-font); background: var(--report-bg); color: var(--report-text); line-height: 1.5; -webkit-font-smoothing: antialiased; }
.report { max-width: 960px; margin: 0 auto; padding: 48px 24px 96px; }
.report-header { margin-bottom: 48px; }
.report-header h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.3px; margin-bottom: 8px; }
.report-meta { font-size: 13px; color: var(--report-text-tertiary); display: flex; gap: 16px; flex-wrap: wrap; }
.report-description { margin-top: 16px; font-size: 15px; color: var(--report-text-secondary); max-width: 640px; }
.stats-bar { display: flex; gap: 12px; margin-bottom: 40px; flex-wrap: wrap; }
.stat-card { flex: 1; min-width: 140px; background: var(--report-surface); border: 1px solid var(--report-border); border-radius: var(--report-radius); padding: 20px; }
.stat-card .stat-value { font-size: 32px; font-weight: 600; letter-spacing: -0.5px; }
.stat-card .stat-label { font-size: 12px; color: var(--report-text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
.stat-covered .stat-value { color: var(--status-covered); }
.stat-gaps .stat-value { color: var(--status-gap); }
.stat-partial .stat-value { color: var(--status-partial); }
.section { margin-bottom: 48px; }
.section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: var(--report-text-tertiary); margin-bottom: 16px; }
.section-divider { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; padding: 10px 16px; }
.section-divider-gap { background: var(--status-gap-bg); color: var(--status-gap); }
.section-divider-partial { background: var(--status-partial-bg); color: var(--status-partial); }
.section-divider-covered { background: var(--status-covered-bg); color: var(--status-covered); }
.section-divider-rec { background: var(--status-rec-bg); color: var(--status-rec); }
.matrix { width: 100%; background: var(--report-surface); border: 1px solid var(--report-border); border-radius: var(--report-radius); overflow: hidden; border-spacing: 0; font-size: 14px; }
.matrix th { text-align: left; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--report-text-tertiary); padding: 12px 16px; background: var(--report-bg); border-bottom: 1px solid var(--report-border); }
.matrix td { padding: 10px 16px; border-bottom: 1px solid var(--report-border-light); vertical-align: top; }
.matrix tr:last-child td { border-bottom: none; }
.state-name { font-weight: 500; }
.state-component { color: var(--report-text-tertiary); font-size: 12px; }
.state-description { color: var(--report-text-secondary); font-size: 13px; }
.file-ref { font-size: 12px; font-family: 'SF Mono', monospace; color: var(--report-text-tertiary); }
.badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 100px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.badge-covered { background: var(--status-covered-bg); color: var(--status-covered); }
.badge-partial { background: var(--status-partial-bg); color: var(--status-partial); }
.badge-gap { background: var(--status-gap-bg); color: var(--status-gap); }
.badge-rec { background: var(--status-rec-bg); color: var(--status-rec); }
.badge-required { background: transparent; border: 1px solid var(--report-border); color: var(--report-text-tertiary); font-size: 11px; padding: 2px 8px; }
.expandable { cursor: pointer; }
.expandable:hover { background: rgba(0,0,0,0.015); }
.expandable .state-name::before { content: ""; display: inline-block; width: 0; height: 0; border-left: 5px solid var(--report-text-tertiary); border-top: 4px solid transparent; border-bottom: 4px solid transparent; margin-right: 8px; transition: transform 0.15s ease; vertical-align: middle; }
.expandable.open .state-name::before { transform: rotate(90deg); }
.state-detail { display: none; }
.state-detail.open { display: table-row; }
.state-detail td { padding: 0; background: var(--report-bg); }
.state-detail-inner { padding: 20px; }
.suggestion { padding: 12px 16px; border-radius: var(--report-radius-sm); font-size: 13px; color: var(--report-text-secondary); margin-bottom: 16px; }
.suggestion-gap { background: var(--status-gap-bg); border-left: 3px solid var(--status-gap); }
.suggestion-partial { background: var(--status-partial-bg); border-left: 3px solid var(--status-partial); }
.suggestion strong { font-weight: 600; }
.suggestion-gap strong { color: var(--status-gap); }
.suggestion-partial strong { color: var(--status-partial); }
.suggestion-recommendation { background: var(--status-rec-bg); border-left: 3px solid var(--status-rec); }
.suggestion-recommendation strong { color: var(--status-rec); }
.detail-notes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; font-size: 13px; }
.note-group h4 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--report-text-tertiary); margin-bottom: 6px; }
.note-group ul { list-style: none; padding: 0; color: var(--report-text-secondary); }
.note-group li { padding: 2px 0; }
.note-group li::before { content: "\\b7"; margin-right: 6px; color: var(--report-text-tertiary); }
.note-group code { font-size: 12px; background: var(--report-surface); padding: 2px 6px; border-radius: 3px; font-family: 'SF Mono', monospace; }
.mockup-container { margin-bottom: 16px; }
.mockup-frame { max-width: 800px; background: #F7F4EF; border: 1px solid var(--report-border); border-radius: var(--report-radius-sm); overflow: hidden; font-family: 'Source Sans 3', system-ui, sans-serif; }
.mockup-label { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; color: var(--report-text-tertiary); margin-bottom: 10px; }
.token-ref { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-family: 'SF Mono', monospace; color: var(--report-text-secondary); background: var(--report-surface); padding: 2px 8px; border-radius: 3px; border: 1px solid var(--report-border-light); }
.token-swatch { width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(0,0,0,0.1); display: inline-block; }
.report-footer { margin-top: 64px; padding-top: 24px; border-top: 1px solid var(--report-border); font-size: 12px; color: var(--report-text-tertiary); display: flex; justify-content: space-between; }
@media print { body { background: white; } .report { padding: 0; max-width: none; } .state-detail { display: table-row !important; } .expandable .state-name::before { display: none; } }`;

// --- Main ---
try {
  const data = loadInput();
  const html = generateReport(data);
  const outPath = data.meta?.output || resolve(__dirname, 'reports', `${(data.meta?.feature || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`);
  writeFileSync(outPath, html);
  console.log(JSON.stringify({ status: 'ok', path: outPath, states: data.auditor?.summary?.total || 0 }));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
