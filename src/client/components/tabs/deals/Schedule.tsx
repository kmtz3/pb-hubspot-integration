import InlineAlert from '../../ui/InlineAlert';

// Phase 1 placeholder. The full deals Schedule UI lands in Phase 5 with a
// cron picker on `schedule.deals` plus the backfill card (D8, D21).
export default function DealsSchedule() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Deals schedule</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
          Cadence and backfill window for syncing HubSpot deals into Productboard notes.
        </p>
      </div>
      <InlineAlert variant="info">
        Coming in the next phase – independent cron from the accounts schedule, plus a backfill picker (last X days / months / years or custom range).
      </InlineAlert>
    </div>
  );
}
