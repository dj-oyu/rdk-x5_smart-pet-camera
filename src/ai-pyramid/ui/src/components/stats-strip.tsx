import type { ActivityStats } from "../lib/api";

type StatsStripProps = {
  stats: ActivityStats | null;
};

const EMPTY_STATS: ActivityStats = {
  total_events: 0,
  confirmed_events: 0,
  rejected_events: 0,
  pending_events: 0
};

export function StatsStrip({ stats }: StatsStripProps) {
  const value = stats ?? EMPTY_STATS;

  return (
    <section class="stats-strip">
      <article>
        <span>Total</span>
        <strong>{value.total_events}</strong>
      </article>
      <article>
        <span>Confirmed</span>
        <strong>{value.confirmed_events}</strong>
      </article>
      <article>
        <span>Pending</span>
        <strong>{value.pending_events}</strong>
      </article>
      <article>
        <span>Rejected</span>
        <strong>{value.rejected_events}</strong>
      </article>
    </section>
  );
}
