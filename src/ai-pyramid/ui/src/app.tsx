import { BackfillButton } from "./components/backfill-button";
import { DailySummary } from "./components/daily-summary";
import { EventDetail } from "./components/event-detail";
import { EventGrid } from "./components/event-grid";
import { FilterBar } from "./components/filter-bar";
import { Pagination } from "./components/pagination";
import { SearchBar } from "./components/search-bar";
import { StatsStrip } from "./components/stats-strip";
import {
  embed,
  query,
  events,
  total,
  stats,
  loading,
  error,
  selectedEvent,
  initialPanel,
  petNames,
  behaviors,
  subtitle,
  updateQuery,
  toggleYoloClass,
  openModal,
  closeModal,
  refresh,
} from "./lib/store";

export function App() {
  if (embed.embedded) {
    return (
      <main class="app-shell compact-shell" data-embed={embed.host ?? undefined}>
        <div class="compact-bar">
          <strong>Recent Events</strong>
          <span>{subtitle}</span>
        </div>
        <EventGrid
          events={events.value}
          loading={loading.value}
          error={error.value}
          petNames={petNames.value}
          onOpenEvent={openModal}
        />
        {selectedEvent.value && (
          <EventDetail
            event={selectedEvent.value}
            petNames={petNames.value}
            onClose={closeModal}
            onUpdated={refresh}
            initialPanel={initialPanel.value}
          />
        )}
        <section class="secondary-stack">
          <FilterBar
            query={query.value}
            petNames={petNames.value}
            onStatusChange={(status) => updateQuery({ status })}
            onPetChange={(petId) => updateQuery({ petId })}
          />
          <StatsStrip stats={stats.value} />
        </section>
      </main>
    );
  }

  return (
    <main class="app-shell standalone-shell">
      <header class="standalone-header">
        <h1 class="standalone-title">Pet Album</h1>
        <SearchBar
          value={query.value.search}
          onChange={(search) => updateQuery({ search })}
        />
      </header>
      <div class="standalone-body">
        <aside class="standalone-sidebar">
          <FilterBar
            query={query.value}
            petNames={petNames.value}
            behaviors={behaviors.value}
            onStatusChange={(status) => updateQuery({ status })}
            onPetChange={(petId) => updateQuery({ petId })}
            onBehaviorChange={(behavior) => updateQuery({ behavior })}
            onYoloClassToggle={toggleYoloClass}
          />
          <DailySummary />
          <BackfillButton />
        </aside>
        <div class="standalone-main">
          <StatsStrip stats={stats.value} />
          <EventGrid
            events={events.value}
            loading={loading.value}
            error={error.value}
            petNames={petNames.value}
            onOpenEvent={openModal}
          />
          <Pagination
            total={total.value}
            limit={query.value.limit}
            offset={query.value.offset}
            onPageChange={(offset) => updateQuery({ offset })}
          />
        </div>
      </div>
      {selectedEvent.value && (
        <EventDetail
          event={selectedEvent.value}
          petNames={petNames.value}
          onClose={closeModal}
          onUpdated={refresh}
          initialPanel={initialPanel.value}
        />
      )}
    </main>
  );
}
