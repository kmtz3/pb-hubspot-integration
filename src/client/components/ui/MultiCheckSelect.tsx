import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

interface Option {
  value: string;
  label: string;
}

interface Props {
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

export default function MultiCheckSelect({ options, selected, onChange, placeholder = 'Select values…' }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
  };

  const triggerLabel = (() => {
    if (selected.length === 0) return null;
    if (selected.length === 1) {
      return options.find(o => o.value === selected[0])?.label ?? selected[0];
    }
    return `${selected.length} selected`;
  })();

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: '0 1 180px', minWidth: 100 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '5px 8px',
          fontSize: 13,
          background: 'var(--background)',
          color: triggerLabel ? 'var(--foreground)' : 'var(--muted-foreground)',
          cursor: 'pointer',
          textAlign: 'left',
          minHeight: 30,
        }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerLabel ?? placeholder}
        </span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--muted-foreground)' }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          minWidth: '100%',
          zIndex: 50,
          background: 'var(--popover)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          boxShadow: 'var(--shadow-sm)',
          maxHeight: 240,
          overflowY: 'auto',
        }}>
          {options.map(o => {
            const checked = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggle(o.value)}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--muted)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 10px',
                  fontSize: 13,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--foreground)',
                  cursor: 'pointer',
                }}>
                <span style={{
                  width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                  border: `1px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
                  background: checked ? 'var(--primary)' : 'var(--background)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {checked && <Check size={11} color="var(--primary-foreground)" strokeWidth={3} />}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
