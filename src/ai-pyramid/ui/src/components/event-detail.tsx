import { useEffect, useMemo } from "preact/hooks";
import {
  updateDetectionOverride,
  updatePhotoFields,
  photoUrl,
  type EventSummary,
  type PetNames,
} from "../lib/api";
import { createDetailStore } from "../lib/detail-store";
import { ComicView } from "./event-detail/comic-view";
import { DetectionList } from "./event-detail/detection-list";
import { MetadataEditor } from "./event-detail/metadata-editor";
import { PanelCarousel } from "./event-detail/panel-carousel";
import { usePanelView } from "./event-detail/use-panel-view";

type Props = {
  event: EventSummary;
  petNames: PetNames;
  onClose: () => void;
  onUpdated?: () => void;
  initialPanel?: number | null;
};

export function EventDetail({ event, petNames, onClose, onUpdated, initialPanel }: Props) {
  const store = useMemo(() => createDetailStore(event, initialPanel ?? null), [event.id]);
  useEffect(() => () => store.dispose(), [store]);
  const panelView = usePanelView(store, event, onClose);

  function handleDetectionOverride(detId: number, newPetId: string) {
    updateDetectionOverride(detId, newPetId).then(() => {
      store.detections.value = store.detections.value.map(det =>
        det.id === detId ? { ...det, pet_id_override: newPetId } : det
      );
      store.editingId.value = null;
    });
  }

  async function handleSave() {
    const patch: Record<string, unknown> = {};
    if (store.formPetId.value !== event.pet_id && store.formPetId.value) patch.pet_id = store.formPetId.value;
    if (store.formBehavior.value !== event.behavior && store.formBehavior.value) patch.behavior = store.formBehavior.value;
    const newIsValid = store.formStatus.value === "valid" ? true : store.formStatus.value === "invalid" ? false : null;
    const oldIsValid = event.status === "valid" ? true : event.status === "invalid" ? false : null;
    if (newIsValid !== oldIsValid && newIsValid !== null) patch.is_valid = newIsValid;
    if (Object.keys(patch).length > 0) {
      await updatePhotoFields(event.source_filename, patch);
      onUpdated?.();
    }
    store.editing.value = false;
  }

  function handleCancel() {
    store.formPetId.value = event.pet_id;
    store.formStatus.value = event.status;
    store.formBehavior.value = event.behavior;
    store.editing.value = false;
  }

  function handleShare() {
    navigator.clipboard.writeText(location.href).then(() => {
      store.copied.value = true;
      setTimeout(() => { store.copied.value = false; }, 2000);
    });
  }

  const downloadHref = store.viewMode.value === "panel"
    ? `${photoUrl(event.source_filename)}/panel/${store.activePanel.value}`
    : photoUrl(event.source_filename);
  const downloadFilename = store.viewMode.value === "panel"
    ? event.source_filename.replace(".jpg", `_p${store.activePanel.value}.jpg`)
    : event.source_filename;

  return (
    <div class="detail-backdrop" onClick={onClose}>
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id="smoke-turbulence">
          <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="3" seed="1">
            <animate attributeName="baseFrequency" values="0.015;0.025;0.015" dur="4s" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" scale="12" />
        </filter>
      </svg>
      <div class="detail-modal" onClick={e => e.stopPropagation()}>
        <button type="button" class="detail-close" onClick={onClose}>✕</button>

        {store.viewMode.value === "panel" && (
          <div class="carousel-breadcrumb">
            <button type="button" class="crumb" onClick={panelView.showComic}>Comic</button>
            <span class="crumb-sep">/</span>
            <span class="crumb current">Panel {store.activePanel.value}</span>
            <a class="pill dl" href={downloadHref} download={downloadFilename}>JPEG P{store.activePanel.value}</a>
            <button type="button" class="pill dl" onClick={handleShare}>{store.copied.value ? "Copied!" : "Share"}</button>
          </div>
        )}

        <ComicView event={event} store={store} onShowPanel={panelView.showPanel} />

        {store.viewMode.value === "panel" && (
          <PanelCarousel
            store={store}
            carouselRef={panelView.carouselRef}
            canvases={panelView.canvasRefs.current!}
            wrappers={panelView.wrapperRefs.current!}
            hdProgressRef={panelView.hdProgressRef}
            onScrollToPanel={panelView.scrollToPanel}
            onZoomToBbox={panelView.zoomToBbox}
          />
        )}

        <div class="detail-info">
          <div class="detail-caption-row">
            <p class="detail-caption">{event.summary ?? "No summary"}</p>
            {store.scanning.value && <span class="detect-now-status">Scanning...</span>}
            {store.viewMode.value === "comic" && (
              <>
                <a class="pill dl" href={photoUrl(event.source_filename)} download={event.source_filename}>JPEG</a>
                <button type="button" class="pill dl" onClick={handleShare}>{store.copied.value ? "Copied!" : "Share"}</button>
              </>
            )}
          </div>

          <MetadataEditor
            event={event}
            petNames={petNames}
            store={store}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        </div>

        <DetectionList
          store={store}
          petNames={petNames}
          onDetectionClick={panelView.handleDetectionClick}
          onOverride={handleDetectionOverride}
        />
      </div>
    </div>
  );
}
