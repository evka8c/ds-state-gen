import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { EmptyState } from '../../components/ui/empty-state';
import { useToast } from '../../components/ui/toast';
import { api } from '../../lib/api';
import { useInvoices } from './useInvoices';
import { InvoiceTable } from './InvoiceTable';
import { BulkDeleteDialog } from './BulkDeleteDialog';

const STATUSES = ['all', 'draft', 'sent', 'paid', 'overdue'] as const;

export function InvoicesPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { invoices, setInvoices, isLoading } = useInvoices({ q, status });
  const { toast } = useToast();

  async function handleBulkDelete() {
    const ids = [...selected];
    setInvoices((prev) => prev.filter((inv) => !selected.has(inv.id)));
    setSelected(new Set());
    setConfirmOpen(false);
    try {
      await api.deleteInvoices(ids);
      toast({ title: `${ids.length} invoice${ids.length === 1 ? '' : 's'} deleted` });
    } catch {
      toast({ title: 'Could not delete invoices', variant: 'destructive' });
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <Button onClick={() => (window.location.href = '/invoices/new')}>New invoice</Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search by customer or number"
          aria-label="Search invoices"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-[var(--radius)] border border-[hsl(var(--border))] px-2 text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <Button
          variant="destructive"
          size="sm"
          className="ml-auto"
          disabled={selected.size === 0}
          onClick={() => setConfirmOpen(true)}
        >
          Delete selected{selected.size > 0 ? ` (${selected.size})` : ''}
        </Button>
      </div>

      {isLoading ? null : invoices.length === 0 ? (
        q ? (
          <EmptyState
            title={`No invoices match “${q}”`}
            description="Check the spelling or search by invoice number."
            action={
              <Button variant="outline" onClick={() => setQ('')}>
                Clear search
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="No invoices yet"
            description="Create your first invoice to start getting paid."
            action={
              <Button onClick={() => (window.location.href = '/invoices/new')}>
                Create invoice
              </Button>
            }
          />
        )
      ) : (
        <InvoiceTable invoices={invoices} selected={selected} onSelectedChange={setSelected} />
      )}

      <BulkDeleteDialog
        open={confirmOpen}
        count={selected.size}
        onOpenChange={setConfirmOpen}
        onConfirm={handleBulkDelete}
      />

      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        <Link to="/settings/billing">Billing settings</Link>
      </p>
    </div>
  );
}
