import { Link } from 'react-router-dom';
import type { Invoice } from '../../lib/api';
import { formatMoney } from '../../lib/utils';

interface InvoiceTableProps {
  invoices: Invoice[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
}

const statusClass: Record<Invoice['status'], string> = {
  draft: 'bg-[hsl(var(--muted))]',
  sent: 'bg-blue-100 text-blue-800',
  paid: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
};

export function InvoiceTable({ invoices, selected, onSelectedChange }: InvoiceTableProps) {
  const allSelected = invoices.length > 0 && invoices.every((i) => selected.has(i.id));

  function toggle(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onSelectedChange(next);
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-[hsl(var(--border))] text-left">
          <th className="w-8 py-2">
            <input
              type="checkbox"
              aria-label="Select all invoices"
              checked={allSelected}
              onChange={() => onSelectedChange(allSelected ? new Set() : new Set(invoices.map((i) => i.id)))}
            />
          </th>
          <th>Number</th>
          <th>Customer</th>
          <th>Status</th>
          <th>Due</th>
          <th className="text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((inv) => (
          <tr key={inv.id} className="border-b border-[hsl(var(--border))]">
            <td className="py-2">
              <input
                type="checkbox"
                aria-label={`Select invoice ${inv.number}`}
                checked={selected.has(inv.id)}
                onChange={() => toggle(inv.id)}
              />
            </td>
            <td>
              <Link to={`/invoices/${inv.id}`} className="font-medium underline-offset-2 hover:underline">
                {inv.number}
              </Link>
            </td>
            <td>{inv.customerName}</td>
            <td>
              <span className={`rounded px-2 py-0.5 text-xs ${statusClass[inv.status]}`}>{inv.status}</span>
            </td>
            <td>{new Date(inv.dueDate).toLocaleDateString()}</td>
            <td className="text-right tabular-nums">{formatMoney(inv.amountCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
