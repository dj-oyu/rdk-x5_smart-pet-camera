import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { TrainingFrame } from "../../lib/training-api";

const THUMB_CACHE_KEY = (id: number) => `thumb_v1_${id}`;

export function TrainingFrameCard({
  frame,
  onClick,
  onApprove,
  onReject,
  onToggleBgRef,
}: {
  frame: TrainingFrame;
  onClick: () => void;
  onApprove: () => void;
  onReject: () => void;
  onToggleBgRef: () => void;
}) {
  const statusClass =
    frame.status === "approved"
      ? "card-approved"
      : frame.status === "rejected"
        ? "card-rejected"
        : "";

  const imgSrc = useSignal<string | null>(
    localStorage.getItem(THUMB_CACHE_KEY(frame.id)),
  );
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (imgSrc.value) return;
    const el = thumbRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        observer.disconnect();
        fetch(`/api/training/frames/${frame.id}/image`)
          .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
          .then(
            (blob) =>
              new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              }),
          )
          .then((dataUrl) => {
            try {
              localStorage.setItem(THUMB_CACHE_KEY(frame.id), dataUrl);
            } catch {
              // localStorage quota exceeded — display without caching
            }
            imgSrc.value = dataUrl;
          })
          .catch(() => {
            imgSrc.value = "error";
          });
      },
      { rootMargin: "120px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [frame.id]);

  return (
    <div
      class={`frame-card ${statusClass} ${frame.is_bg_ref ? "card-bg-ref" : ""}`}
    >
      <div class="frame-thumb" ref={thumbRef} onClick={onClick}>
        {imgSrc.value && imgSrc.value !== "error" ? (
          <img src={imgSrc.value} alt={frame.filename} />
        ) : imgSrc.value === "error" ? (
          <div class="thumb-placeholder thumb-error">!</div>
        ) : (
          <div class="thumb-placeholder" />
        )}
        {frame.annotation_count > 0 && (
          <span class="ann-badge">{frame.annotation_count}</span>
        )}
        {frame.bg_score !== null && frame.bg_score !== undefined && (
          <span
            class={`bg-score-badge ${frame.bg_score <= 5 ? "score-empty" : frame.bg_score >= 30 ? "score-occupied" : "score-mid"}`}
            title={`Background score: ${frame.bg_score.toFixed(1)}%`}
          >
            {frame.bg_score.toFixed(0)}%
          </span>
        )}
      </div>
      <div class="frame-info">
        <span class="frame-name" title={frame.filename}>
          {frame.filename.replace(/_\d+x\d+\.(?:nv12|webp)$/, "")}
        </span>
        <div class="frame-actions">
          <button
            class={`btn-bg-ref ${frame.is_bg_ref ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleBgRef();
            }}
            title={
              frame.is_bg_ref
                ? "Remove background reference"
                : "Mark as background reference"
            }
          >
            ◆
          </button>
          <button
            class="btn-approve"
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
            title="Approve"
          >
            O
          </button>
          <button
            class="btn-reject"
            onClick={(e) => {
              e.stopPropagation();
              onReject();
            }}
            title="Reject"
          >
            X
          </button>
        </div>
      </div>
    </div>
  );
}
