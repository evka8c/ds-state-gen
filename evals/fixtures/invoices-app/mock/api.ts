import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Status = 'draft' | 'sent' | 'paid' | 'overdue';
interface Attachment { id: string; name: string; size: number }
interface Invoice {
  id: string; number: string; customerName: string; customerEmail: string;
  amountCents: number; status: Status; dueDate: string; attachments: Attachment[];
}

const seed: Array<[string, string, number, Status, string]> = [
  ['Acme Corp', 'billing@acme.com', 482000, 'paid', '2026-08-15'],
  ['Globex Ltd', 'ap@globex.io', 129950, 'sent', '2026-10-05'],
  ['Initech', 'finance@initech.com', 75000, 'overdue', '2026-09-01'],
  ['Umbrella Health', 'invoices@umbrella.health', 1024000, 'draft', '2026-10-20'],
  ['Stark Industries', 'pay@stark.com', 350000, 'sent', '2026-10-12'],
  ['Wayne Enterprises', 'ap@wayne.com', 899900, 'paid', '2026-07-30'],
  ['Hooli', 'accounts@hooli.xyz', 42500, 'overdue', '2026-08-28'],
  ['Pied Piper', 'richard@piedpiper.com', 18000, 'draft', '2026-11-01'],
];

let nextId = 1;
const invoices: Invoice[] = seed.map(([customerName, customerEmail, amountCents, status, dueDate], i) => ({
  id: String(nextId++),
  number: `INV-${String(1001 + i)}`,
  customerName, customerEmail, amountCents, status, dueDate,
  attachments: i === 0 ? [{ id: 'a1', name: 'contract.pdf', size: 184320 }] : [],
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString() || '{}'); } catch { return {}; }
}

const LOGIN_HTML = `<!doctype html><html><head><title>Sign in</title></head>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f8fafc">
<div style="padding:32px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;text-align:center">
<h1 style="margin:0 0 8px;font-size:20px">Sign in</h1>
<p style="color:#64748b;margin:0 0 16px">Your session expired (mock login page).</p>
<a href="/invoices" style="color:#2563eb">Back to invoices</a></div></body></html>`;

export function mockApi(): Plugin {
  return {
    name: 'mock-invoices-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (path === '/login') {
          res.setHeader('Content-Type', 'text/html');
          return res.end(LOGIN_HTML);
        }
        if (!path.startsWith('/api/')) return next();

        await sleep(300);

        if (path === '/api/invoices' && method === 'GET') {
          const q = url.searchParams.get('q')?.toLowerCase();
          const status = url.searchParams.get('status');
          let list = invoices;
          if (q) list = list.filter((i) => [i.number, i.customerName, i.customerEmail].some((s) => s.toLowerCase().includes(q)));
          if (status) list = list.filter((i) => i.status === status);
          return send(res, 200, list);
        }
        if (path === '/api/invoices' && method === 'POST') {
          const b = await readJson(req);
          if (!b.customerName || !b.customerEmail || typeof b.amountCents !== 'number' || !b.dueDate) {
            return send(res, 422, { message: 'customerName, customerEmail, amountCents and dueDate are required' });
          }
          const inv: Invoice = {
            id: String(nextId++),
            number: `INV-${1000 + nextId}`,
            customerName: b.customerName, customerEmail: b.customerEmail,
            amountCents: b.amountCents, status: 'draft', dueDate: b.dueDate, attachments: [],
          };
          invoices.unshift(inv);
          return send(res, 201, inv);
        }
        if (path === '/api/invoices/bulk-delete' && method === 'POST') {
          const { ids } = await readJson(req);
          if (!Array.isArray(ids)) return send(res, 400, { message: 'ids must be an array' });
          for (let i = invoices.length - 1; i >= 0; i--) if (ids.includes(invoices[i].id)) invoices.splice(i, 1);
          return send(res, 204);
        }

        const att = path.match(/^\/api\/invoices\/([^/]+)\/attachments$/);
        if (att && method === 'POST') {
          const inv = invoices.find((i) => i.id === att[1]);
          if (!inv) return send(res, 404, { message: 'Invoice not found' });
          const buf = await readBody(req);
          const nameMatch = buf.toString('latin1').match(/filename="([^"]*)"/);
          const a: Attachment = { id: `a${Date.now()}`, name: nameMatch?.[1] ?? 'upload', size: buf.length };
          inv.attachments.push(a);
          return send(res, 201, a);
        }

        const one = path.match(/^\/api\/invoices\/([^/]+)$/);
        if (one) {
          const idx = invoices.findIndex((i) => i.id === one[1]);
          if (idx < 0) return send(res, 404, { message: 'Invoice not found' });
          if (method === 'GET') return send(res, 200, invoices[idx]);
          if (method === 'DELETE') { invoices.splice(idx, 1); return send(res, 204); }
        }

        return send(res, 404, { message: `No mock for ${method} ${path}` });
      });
    },
  };
}
