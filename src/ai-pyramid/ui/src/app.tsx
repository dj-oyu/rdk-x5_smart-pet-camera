import { useModel } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { BackfillButton } from "./components/backfill-button";
import { DailySummary } from "./components/daily-summary";
import { EventDetail } from "./components/event-detail";
import { EventGrid } from "./components/event-grid";
import { FilterBar } from "./components/filter-bar";
import { Pagination } from "./components/pagination";
import { SearchBar } from "./components/search-bar";
import { StatsStrip } from "./components/stats-strip";
import { AnnotatePage } from "./components/training/annotate-page";
import { AppStore, embed } from "./lib/store";

export function App() {
  // Route: /app/annotate → training annotation UI
  if (window.location.pathname.startsWith("/app/annotate")) {
    return <AnnotatePage />;
  }
  const store = useModel(AppStore);

  if (embed.embedded) {
    return (
      <main class="app-shell compact-shell" data-embed={embed.host ?? undefined}>
        <div class="compact-bar">
          <strong>Recent Events</strong>
          <span>{store.subtitle.value}</span>
        </div>
        <EventGrid
          events={store.events.value}
          loading={store.loading.value}
          error={store.error.value}
          petNames={store.petNames.value}
          onOpenEvent={store.openModal}
        />
        <Show when={store.selectedEvent}>
          {(ev) => (
            <EventDetail
              event={ev}
              petNames={store.petNames.value}
              onClose={store.closeModal}
              onUpdated={store.loadData}
              initialPanel={store.initialPanel.value}
            />
          )}
        </Show>
        <section class="secondary-stack">
          <FilterBar
            query={store.query.value}
            petNames={store.petNames.value}
            onStatusChange={(status) => store.updateQuery({ status })}
            onPetChange={(petId) => store.updateQuery({ petId })}
          />
          <StatsStrip stats={store.stats.value} />
        </section>
      </main>
    );
  }

  return (
    <main class="app-shell standalone-shell">
      <header class="standalone-header">
        <h1 class="standalone-title">Pet Album</h1>
        <SearchBar
          value={store.query.value.search}
          onChange={(search) => store.updateQuery({ search })}
        />
      </header>
      <div class="standalone-body">
        <aside class="standalone-sidebar">
          <FilterBar
            query={store.query.value}
            petNames={store.petNames.value}
            behaviors={store.behaviors.value}
            onStatusChange={(status) => store.updateQuery({ status })}
            onPetChange={(petId) => store.updateQuery({ petId })}
            onBehaviorChange={(behavior) => store.updateQuery({ behavior })}
            onYoloClassToggle={store.toggleYoloClass}
          />
          <DailySummary />
          <BackfillButton />
          <a href="/app/annotate" class="sidebar-link">Training Annotator</a>
        </aside>
        <div class="standalone-main">
          <StatsStrip stats={store.stats.value} />
          <EventGrid
            events={store.events.value}
            loading={store.loading.value}
            error={store.error.value}
            petNames={store.petNames.value}
            onOpenEvent={store.openModal}
          />
          <Pagination
            total={store.total.value}
            limit={store.query.value.limit}
            offset={store.query.value.offset}
            onPageChange={(offset) => store.updateQuery({ offset })}
          />
        </div>
      </div>
      <Show when={store.selectedEvent}>
        {(ev) => (
          <EventDetail
            event={ev}
            petNames={store.petNames.value}
            onClose={store.closeModal}
            onUpdated={store.loadData}
            initialPanel={store.initialPanel.value}
          />
        )}
      </Show>
    </main>
  );
}
