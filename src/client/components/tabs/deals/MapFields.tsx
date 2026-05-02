import InlineAlert from '../../ui/InlineAlert';

// Phase 1 placeholder. The full deals MapFields UI lands in Phase 5 with two
// stacked sections (Tags + Body) writing into `fieldMappings.deals`.
export default function DealsMapFields() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Map deal fields</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
          Decide which HubSpot deal fields become tags or note body content in Productboard.
        </p>
      </div>
      <InlineAlert variant="info">
        Coming in the next phase – tags + conditional rules section, then a drag-orderable note-body table with Metadata / Longform styles.
      </InlineAlert>
    </div>
  );
}
