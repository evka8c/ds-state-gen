export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue';

export interface Invoice {
  id: string;
  number: string;
  customerName: string;
  customerEmail: string;
  amountCents: number;
  status: InvoiceStatus;
  dueDate: string;
  attachments: { id: string; name: string; size: number }[];
}

export interface NewInvoice {
  customerName: string;
  customerEmail: string;
  amountCents: number;
  dueDate: string;
  notes?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    headers: init?.body instanceof FormData ? init?.headers : { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (res.status === 401) {
    window.location.href = '/login';
    return new Promise<T>(() => {});
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message ?? res.statusText);
  }

  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  listInvoices: (params: { q?: string; status?: string }) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.status && params.status !== 'all') search.set('status', params.status);
    return request<Invoice[]>(`/invoices?${search}`);
  },
  getInvoice: (id: string) => request<Invoice>(`/invoices/${id}`),
  createInvoice: (data: NewInvoice) => request<Invoice>('/invoices', { method: 'POST', body: JSON.stringify(data) }),
  deleteInvoices: (ids: string[]) => request<void>('/invoices/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  deleteInvoice: (id: string) => request<void>(`/invoices/${id}`, { method: 'DELETE' }),
  uploadAttachment: (invoiceId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ id: string; name: string; size: number }>(`/invoices/${invoiceId}/attachments`, {
      method: 'POST',
      body: form,
    });
  },
};
