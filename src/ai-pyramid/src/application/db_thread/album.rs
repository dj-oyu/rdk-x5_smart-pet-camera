use super::{DbCommand, send_reply};
use crate::db::PhotoStore;

/// Dispatch an album-domain command selected by `DbCommand::into_domain`.
pub(super) fn dispatch(store: &PhotoStore, command: DbCommand) {
    match command {
        DbCommand::InsertPhoto {
            filename,
            captured_at,
            pet_id,
            reply,
        } => send_reply(
            reply,
            store.insert(&filename, captured_at, pet_id.as_deref()),
        ),
        DbCommand::GetPhoto { filename, reply } => {
            send_reply(reply, store.get_by_filename(&filename))
        }
        DbCommand::GetPhotoById { id, reply } => send_reply(reply, store.get_by_id(id)),
        DbCommand::ListPhotos { filter, reply } => send_reply(reply, store.list(&filter)),
        DbCommand::ListPendingFilenames {
            max_attempts,
            reply,
        } => send_reply(reply, store.list_pending_filenames(max_attempts)),
        DbCommand::ApplyVlmResult {
            filename,
            is_valid,
            caption,
            behavior,
            reply,
        } => send_reply(
            reply,
            store.update_vlm_result(&filename, is_valid, &caption, &behavior),
        ),
        DbCommand::OverrideValidation {
            filename,
            is_valid,
            reply,
        } => send_reply(reply, store.set_validation_override(&filename, is_valid)),
        DbCommand::RecordVlmFailure {
            filename,
            error,
            reply,
        } => send_reply(reply, store.record_vlm_failure(&filename, &error)),
        DbCommand::Stats { reply } => send_reply(reply, store.stats()),
        DbCommand::GetVlmAttempts { filename, reply } => {
            send_reply(reply, store.get_vlm_attempts(&filename))
        }
        DbCommand::IngestWithDetections {
            filename,
            captured_at,
            pet_id,
            detections,
            reply,
        } => send_reply(
            reply,
            store.ingest_with_detections(&filename, captured_at, pet_id.as_deref(), &detections),
        ),
        DbCommand::GetDetections { photo_id, reply } => {
            send_reply(reply, store.get_detections(photo_id))
        }
        DbCommand::UpdateDetectionOverride {
            detection_id,
            pet_id,
            reply,
        } => send_reply(
            reply,
            store.update_detection_override(detection_id, &pet_id),
        ),
        DbCommand::UpdatePetId {
            filename,
            pet_id,
            reply,
        } => send_reply(reply, store.update_pet_id(&filename, &pet_id)),
        DbCommand::UpdateBehavior {
            filename,
            behavior,
            reply,
        } => send_reply(reply, store.update_behavior(&filename, &behavior)),
        DbCommand::DistinctPetIds { reply } => send_reply(reply, store.distinct_pet_ids()),
        DbCommand::DistinctBehaviors { reply } => send_reply(reply, store.distinct_behaviors()),
        DbCommand::CaptionsForDate { date, reply } => {
            send_reply(reply, store.captions_for_date(&date))
        }
        DbCommand::ListUndetectedPhotos { limit, reply } => {
            send_reply(reply, store.list_undetected_photos(limit))
        }
        DbCommand::MarkDetected { photo_id, reply } => {
            send_reply(reply, store.mark_detected(photo_id))
        }
        DbCommand::RecordEmptyLevel2 { photo_id, reply } => {
            send_reply(reply, store.record_empty_level2(photo_id))
        }
        DbCommand::GetEditHistory { since, reply } => {
            send_reply(reply, store.get_edit_history(since.as_deref()))
        }
        DbCommand::GetBboxesForPhotos { photo_ids, reply } => {
            send_reply(reply, store.get_bboxes_for_photos(&photo_ids))
        }
        DbCommand::TrainingUpsertFrame { .. }
        | DbCommand::TrainingListFrames { .. }
        | DbCommand::TrainingGetFrame { .. }
        | DbCommand::TrainingUpdateStatus { .. }
        | DbCommand::TrainingListAnnotations { .. }
        | DbCommand::TrainingReplaceAnnotations { .. }
        | DbCommand::TrainingDeleteAnnotation { .. }
        | DbCommand::TrainingDeleteRejected { .. }
        | DbCommand::TrainingStats { .. }
        | DbCommand::TrainingExport { .. }
        | DbCommand::TrainingSetBgRef { .. }
        | DbCommand::TrainingListBgRefFrames { .. }
        | DbCommand::TrainingBgRefCount { .. }
        | DbCommand::TrainingBulkUpdateBgScores { .. }
        | DbCommand::TrainingBulkRejectByScore { .. } => {
            unreachable!("non-album command reached album dispatcher")
        }
    }
}
