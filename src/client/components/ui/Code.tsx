import type { ReactNode } from 'react';

export default function Code({ children }: { children: ReactNode }) {
  return (
    <code style={{ background: 'var(--muted)', borderRadius: 'var(--radius-sm)', padding: '2px 4px', fontFamily: 'var(--font-mono)', fontSize: '0.8em' }}>
      {children}
    </code>
  );
}
