import type { ReactNode } from 'react';

type Variant = 'default' | 'success' | 'warning' | 'destructive' | 'purple' | 'mono';

const styles: Record<Variant, string> = {
  default:     'bg-[color:var(--muted)] text-[color:var(--muted-foreground)]',
  success:     'bg-[color:var(--success-accent)] text-[color:var(--success-accent-foreground)]',
  warning:     'bg-[color:var(--warning-accent)] text-[color:var(--warning-accent-foreground)]',
  destructive: 'bg-[color:var(--destructive-accent)] text-[color:var(--destructive-accent-foreground)]',
  purple:      'bg-purple-100 text-purple-800',
  mono:        'bg-[color:var(--muted)] text-[color:var(--muted-foreground)] font-mono',
};

export default function Badge({ variant = 'default', children }: { variant?: Variant; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${styles[variant]}`}>
      {children}
    </span>
  );
}
