import * as React from 'react';
import { createPortal } from 'react-dom';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-[var(--radius)] bg-[hsl(var(--background))] p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export const DialogTitle = (p: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="text-lg font-semibold" {...p} />;
export const DialogDescription = (p: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]" {...p} />
);
export const DialogFooter = (p: React.HTMLAttributes<HTMLDivElement>) => <div className="mt-6 flex justify-end gap-2" {...p} />;
