import * as React from 'react';

type ToastVariant = 'default' | 'destructive';
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant?: ToastVariant;
}

const ToastContext = React.createContext<{ toast: (t: Omit<ToastItem, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  const toast = React.useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 5000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={
              t.variant === 'destructive'
                ? 'rounded-[var(--radius)] bg-[hsl(var(--destructive))] p-4 text-[hsl(var(--destructive-foreground))]'
                : 'rounded-[var(--radius)] border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4'
            }
          >
            <p className="font-medium">{t.title}</p>
            {t.description && <p className="text-sm opacity-90">{t.description}</p>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
