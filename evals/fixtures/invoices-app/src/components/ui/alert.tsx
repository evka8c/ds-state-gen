import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const alertVariants = cva('relative w-full rounded-[var(--radius)] border p-4 text-sm', {
  variants: {
    variant: {
      default: 'border-[hsl(var(--border))] bg-[hsl(var(--background))]',
      destructive: 'border-[hsl(var(--destructive))] text-[hsl(var(--destructive))]',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Alert({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle(props: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className="mb-1 font-medium leading-none" {...props} />;
}

export function AlertDescription(props: React.HTMLAttributes<HTMLParagraphElement>) {
  return <div className="text-sm opacity-90" {...props} />;
}
