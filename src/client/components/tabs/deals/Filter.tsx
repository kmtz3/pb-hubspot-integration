import InlineAlert from '../../ui/InlineAlert';

// Phase 1 placeholder. The full deals filter UI (pipeline + stage selectors,
// shared filter-group repeater) lands in Phase 5. The data shape it will
// write is `filters.deals` per `src/types/sync.ts`.
export default function DealsFilter() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Filter deals</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
          Pick the HubSpot pipeline and stages whose deals should sync as Productboard notes.
        </p>
      </div>
      <InlineAlert variant="info">
        Coming in the next phase – pipeline picker, stage multiselect, and the same filter-group repeater accounts uses today.
      </InlineAlert>
    </div>
  );
}
