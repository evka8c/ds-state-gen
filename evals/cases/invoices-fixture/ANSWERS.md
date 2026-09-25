# invoices-app fixture: planted answers

Kept here, outside `evals/fixtures/invoices-app/`, so a skill run pointed at the fixture can't read them. `case.json` is the machine-readable version.

| # | Planted gap | Where | Consequence | Must find |
|---|---|---|---|---|
| 1 | Submit button not disabled while creating: double click sends two invoices | CreateInvoiceForm.tsx:36, :111 | misleading (blocker accepted) | yes |
| 2 | List fetch error caught and turned into `[]`, so the page says "No invoices yet" | useInvoices.ts:13-14, InvoicesPage.tsx:87 | misleading | yes |
| 3 | 401 hard-redirects to /login (and returns a never-resolving promise): unsent form input is lost | api.ts:35-37 | blocker | yes |
| 4 | Bulk delete is optimistic; on failure toast only, rows never come back | InvoicesPage.tsx:24-31 | misleading | yes |
| 5 | Detail delete closes dialog, toasts "Invoice deleted" and navigates before the request; failure unhandled | InvoiceDetail.tsx:44-49 | misleading | yes |
| 6 | Status-filter empty falls through to "No invoices yet" + Create CTA; no clear filter | InvoicesPage.tsx:74-95 | nuisance | no |
| 7 | Upload hint promises type/size limits but no `accept` or size check; generic "Upload failed" | AttachmentUpload.tsx:21-25, :36 | nuisance | no |
| 8 | List renders nothing while loading | InvoicesPage.tsx:74 | nuisance | no |

Correctly handled (must not be flagged): search no-results with query + Clear search; inline form validation with aria; detail Skeleton; detail 404 and error+Try again; bulk delete disabled with no selection; upload button loading.

Not planted but defensible if found (score as "needs human review"): offline, keyboard/screen reader details of the custom Dialog (no focus trap), list 401 hanging forever.
