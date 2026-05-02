import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Search, X } from 'lucide-react';

// Lowercase + strip diacritics + drop everything that isn't a letter or digit.
// Used on both the haystack (option label/internal name) and the needle so that
// "Région‑Île" matches "regionile" and "_email" matches "email".
export function normalize(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface SearchableGroup<T> {
  type: string;
  label: string;
  items: T[];
}

interface Props<T> {
  value: string;
  onChange: (next: string) => void;
  groups: SearchableGroup<T>[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  // Optional secondary line shown under the label (e.g. internal property name).
  getSubLabel?: (item: T) => string | null | undefined;
  // Free-form text that should also count as a search match (e.g. internal name).
  getSearchText?: (item: T) => string;
  // Render the trigger label for a selected value.
  renderSelected?: (value: string) => React.ReactNode;
  placeholder: string;
  // Optional first row whose value bypasses group filtering (e.g. "Not mapped").
  emptyOption?: { value: string; label: string };
  disabled?: boolean;
  searchPlaceholder?: string;
}

export default function SearchableSelect<T>({
  value,
  onChange,
  groups,
  getKey,
  getLabel,
  getSubLabel,
  getSearchText,
  renderSelected,
  placeholder,
  emptyOption,
  disabled,
  searchPlaceholder = 'Search…',
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Per-group collapsed state, keyed by group.type. Force-ignored while a
  // search query is active so matches stay visible regardless of user toggles.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
    // Defer focus so the click that opened the popover doesn't immediately blur it.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open]);

  // Reset the query each time the popover closes so the next open starts fresh.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const filteredGroups = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((it) => {
          const hay = normalize(getLabel(it)) + normalize(getSearchText?.(it) ?? '');
          return hay.includes(needle);
        }),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query, getLabel, getSearchText]);

  const totalMatches = filteredGroups.reduce((n, g) => n + g.items.length, 0);

  // Resolve the trigger label and the type chip for the selected value, so the
  // chip stays visible after selection (matches the chip shown on each option).
  // emptyOption short-circuits because its value (often '') won't appear in any
  // group, and a custom renderSelected suppresses the chip — the consumer is
  // taking over rendering.
  const { triggerLabel, selectedGroupLabel } = (() => {
    if (emptyOption && value === emptyOption.value) {
      return { triggerLabel: emptyOption.label as React.ReactNode, selectedGroupLabel: null as string | null };
    }
    if (renderSelected) {
      return { triggerLabel: renderSelected(value), selectedGroupLabel: null };
    }
    for (const g of groups) {
      for (const it of g.items) {
        if (getKey(it) === value) {
          return { triggerLabel: getLabel(it) as React.ReactNode, selectedGroupLabel: g.label };
        }
      }
    }
    return { triggerLabel: placeholder as React.ReactNode, selectedGroupLabel: null };
  })();

  const isPlaceholder = !value || (emptyOption && value === emptyOption.value);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '5px 8px',
          fontSize: 13,
          background: 'var(--background)',
          color: isPlaceholder ? 'var(--muted-foreground)' : 'var(--foreground)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          minHeight: 30,
        }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerLabel}
        </span>
        {selectedGroupLabel && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--muted-foreground)',
              background: 'var(--muted)',
              padding: '2px 6px',
              borderRadius: 4,
            }}>
            {selectedGroupLabel}
          </span>
        )}
        <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--muted-foreground)' }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 50,
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: 'var(--shadow-sm)',
            maxHeight: 320,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
            <Search size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 13,
                color: 'var(--foreground)',
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2, display: 'flex' }}>
                <X size={13} />
              </button>
            )}
            {!query && filteredGroups.length > 1 && (() => {
              // "All collapsed" means every visible group is in the collapsed set.
              // Toggle flips between collapse-all and expand-all on that basis.
              const allCollapsed = filteredGroups.every((g) => collapsed.has(g.type));
              return (
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed(allCollapsed ? new Set() : new Set(filteredGroups.map((g) => g.type)))
                  }
                  aria-label={allCollapsed ? 'Expand all groups' : 'Collapse all groups'}
                  title={allCollapsed ? 'Expand all' : 'Collapse all'}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2, display: 'flex' }}>
                  {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
                </button>
              );
            })()}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {emptyOption && !query && (
              <button
                type="button"
                onClick={() => {
                  onChange(emptyOption.value);
                  setOpen(false);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 12px',
                  fontSize: 13,
                  border: 'none',
                  background: value === emptyOption.value ? 'var(--accent)' : 'transparent',
                  color: 'var(--muted-foreground)',
                  cursor: 'pointer',
                  fontStyle: 'italic',
                }}>
                {emptyOption.label}
              </button>
            )}

            {totalMatches === 0 ? (
              <div style={{ padding: '12px', fontSize: 12, color: 'var(--muted-foreground)', textAlign: 'center' }}>
                No matches
              </div>
            ) : (
              filteredGroups.map((g) => {
                const isCollapsed = !query && collapsed.has(g.type);
                return (
                  <div key={g.type}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.type)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        width: '100%',
                        padding: '6px 12px 4px',
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: 'var(--muted-foreground)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}>
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      <span>{g.label}</span>
                      <span style={{ marginLeft: 4, fontWeight: 400, opacity: 0.7 }}>{g.items.length}</span>
                    </button>
                    {!isCollapsed && g.items.map((it) => {
                      const k = getKey(it);
                      const isSelected = k === value;
                      const sub = getSubLabel?.(it);
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => {
                            onChange(k);
                            setOpen(false);
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'var(--muted)';
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            textAlign: 'left',
                            padding: '6px 12px',
                            fontSize: 13,
                            border: 'none',
                            background: isSelected ? 'var(--accent)' : 'transparent',
                            color: isSelected ? 'var(--accent-foreground)' : 'var(--foreground)',
                            cursor: 'pointer',
                          }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: isSelected ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {getLabel(it)}
                            </div>
                            {sub && (
                              <div style={{ fontSize: 11, color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {sub}
                              </div>
                            )}
                          </div>
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 10,
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                              color: 'var(--muted-foreground)',
                              background: 'var(--muted)',
                              padding: '2px 6px',
                              borderRadius: 4,
                            }}>
                            {g.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
