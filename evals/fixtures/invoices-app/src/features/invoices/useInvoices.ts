import { useCallback, useEffect, useState } from 'react';
import { api, type Invoice } from '../../lib/api';

export function useInvoices(params: { q: string; status: string }) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await api.listInvoices(params);
      setInvoices(data);
    } catch {
      setInvoices([]);
    } finally {
      setIsLoading(false);
    }
  }, [params.q, params.status]);

  useEffect(() => {
    load();
  }, [load]);

  return { invoices, setInvoices, isLoading, reload: load };
}
