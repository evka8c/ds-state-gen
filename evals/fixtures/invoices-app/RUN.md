# Running the invoices fixture

```
npm install
npx vite --port 5179
```
Open http://localhost:5179 (redirects to /invoices). The mock API lives in `mock/api.ts` (Vite middleware, in-memory, 300ms latency, resets on restart).

## Endpoints
- `GET /api/invoices?q=&status=` — list (8 seeded invoices; q matches number/name/email)
- `GET /api/invoices/:id` — one invoice (404 if missing)
- `POST /api/invoices` — create (422 if fields missing)
- `DELETE /api/invoices/:id` — delete (204)
- `POST /api/invoices/bulk-delete` — body `{ "ids": [...] }` (204)
- `POST /api/invoices/:id/attachments` — multipart `file` upload
- `GET /login` — static page the 401 redirect lands on
