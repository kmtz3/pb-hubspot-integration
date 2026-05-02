import type { ReactNode } from 'react';

type Variant = 'info' | 'warning' | 'success' | 'destructive';

const styles: Record<Variant, string> = {
  info:        'bg-[color:var(--accent)] border-[color:var(--accent-foreground)] text-[color:var(--accent-foreground)]',
  warning:     'bg-[color:var(--warning-accent)] border-[color:var(--warning-accent-foreground)] text-[color:var(--warning-accent-foreground)]',
  success:     'bg-[color:var(--success-accent)] border-[color:var(--success-accent-foreground)] text-[color:var(--success-accent-foreground)]',
  destructive: 'bg-[color:var(--destructive-accent)] border-[color:var(--destructive-accent-foreground)] text-[color:var(--destructive-accent-foreground)]',
};

export default function InlineAlert({ variant = 'info', children }: { variant?: Variant; children: ReactNode }) {
  return (
    <div className={`inline-alert flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${styles[variant]}`}
         style={{ borderWidth: 1 }}>
      {children}
    </div>
  );
}
