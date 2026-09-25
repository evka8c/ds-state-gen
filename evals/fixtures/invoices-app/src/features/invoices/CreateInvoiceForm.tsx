import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useToast } from '../../components/ui/toast';
import { api } from '../../lib/api';

type Errors = Partial<Record<'customerName' | 'customerEmail' | 'amount' | 'dueDate', string>>;

function validate(values: { customerName: string; customerEmail: string; amount: string; dueDate: string }): Errors {
  const errors: Errors = {};
  if (!values.customerName.trim()) errors.customerName = 'Customer name is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.customerEmail)) errors.customerEmail = 'Enter a valid email address';
  const amount = Number(values.amount);
  if (!values.amount || Number.isNaN(amount) || amount <= 0) errors.amount = 'Amount must be greater than 0';
  if (!values.dueDate) errors.dueDate = 'Pick a due date';
  return errors;
}

export function CreateInvoiceForm() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [values, setValues] = useState({ customerName: '', customerEmail: '', amount: '', dueDate: '', notes: '' });
  const [errors, setErrors] = useState<Errors>({});

  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    try {
      const invoice = await api.createInvoice({
        customerName: values.customerName.trim(),
        customerEmail: values.customerEmail.trim(),
        amountCents: Math.round(Number(values.amount) * 100),
        dueDate: values.dueDate,
        notes: values.notes || undefined,
      });
      toast({ title: `Invoice ${invoice.number} created` });
      navigate(`/invoices/${invoice.id}`);
    } catch (err) {
      toast({
        title: 'Could not create invoice',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
  }

  const field = (name: keyof Errors, label: string, input: React.ReactNode) => (
    <div className="space-y-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      {input}
      {errors[name] && (
        <p id={`${name}-error`} className="text-sm text-[hsl(var(--destructive))]">
          {errors[name]}
        </p>
      )}
    </div>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-2xl font-semibold">New invoice</h1>
      {field(
        'customerName',
        'Customer name',
        <Input id="customerName" value={values.customerName} onChange={set('customerName')}
          aria-invalid={!!errors.customerName} aria-describedby={errors.customerName ? 'customerName-error' : undefined} />,
      )}
      {field(
        'customerEmail',
        'Customer email',
        <Input id="customerEmail" type="email" value={values.customerEmail} onChange={set('customerEmail')}
          aria-invalid={!!errors.customerEmail} aria-describedby={errors.customerEmail ? 'customerEmail-error' : undefined} />,
      )}
      {field(
        'amount',
        'Amount (USD)',
        <Input id="amount" inputMode="decimal" value={values.amount} onChange={set('amount')}
          aria-invalid={!!errors.amount} aria-describedby={errors.amount ? 'amount-error' : undefined} />,
      )}
      {field(
        'dueDate',
        'Due date',
        <Input id="dueDate" type="date" value={values.dueDate} onChange={set('dueDate')}
          aria-invalid={!!errors.dueDate} aria-describedby={errors.dueDate ? 'dueDate-error' : undefined} />,
      )}
      <div className="space-y-1">
        <label htmlFor="notes" className="text-sm font-medium">
          Notes
        </label>
        <textarea
          id="notes"
          rows={4}
          value={values.notes}
          onChange={set('notes')}
          className="w-full rounded-[var(--radius)] border border-[hsl(var(--border))] p-3 text-sm"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => navigate('/invoices')}>
          Cancel
        </Button>
        <Button type="submit">Create invoice</Button>
      </div>
    </form>
  );
}
