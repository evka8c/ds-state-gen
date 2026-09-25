import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '../../components/ui/dialog';
import { Skeleton } from '../../components/ui/skeleton';
import { useToast } from '../../components/ui/toast';
import { api, ApiError, type Invoice } from '../../lib/api';
import { formatMoney } from '../../lib/utils';
import { AttachmentUpload } from './AttachmentUpload';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; notFound: boolean; message: string }
  | { status: 'ready'; invoice: Invoice };

export function InvoiceDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .getInvoice(id)
      .then((invoice) => !cancelled && setState({ status: 'ready', invoice }))
      .catch((err) => {
        if (cancelled) return;
        setState({
          status: 'error',
          notFound: err instanceof ApiError && err.status === 404,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  function onDelete() {
    setConfirmDelete(false);
    toast({ title: 'Invoice deleted' });
    navigate('/invoices');
    api.deleteInvoice(id);
  }

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6" aria-busy="true" aria-label="Loading invoice">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="mx-auto max-w-3xl p-6">
        {state.notFound ? (
          <Alert>
            <AlertTitle>Invoice not found</AlertTitle>
            <AlertDescription>
              It may have been deleted. <Link to="/invoices">Back to invoices</Link>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTitle>Couldn't load this invoice</AlertTitle>
            <AlertDescription>
              {state.message}{' '}
              <Button variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  const { invoice } = state;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Invoice {invoice.number}</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {invoice.customerName} · due {new Date(invoice.dueDate).toLocaleDateString()}
          </p>
        </div>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(invoice.amountCents)}</p>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Attachments</h2>
        {invoice.attachments.length === 0 ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">No files attached.</p>
        ) : (
          <ul className="text-sm">
            {invoice.attachments.map((a) => (
              <li key={a.id}>{a.name}</li>
            ))}
          </ul>
        )}
        <AttachmentUpload
          invoiceId={invoice.id}
          onUploaded={(a) => setState({ status: 'ready', invoice: { ...invoice, attachments: [...invoice.attachments, a] } })}
        />
      </section>

      <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
        Delete invoice
      </Button>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogTitle>Delete invoice {invoice.number}?</DialogTitle>
        <DialogDescription>The customer will no longer be able to view or pay it.</DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onDelete}>
            Delete
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
