use super::{DbCommand, send_reply};
use crate::db::PhotoStore;

/// Dispatch a training-domain command selected by `DbCommand::into_domain`.
pub(super) fn dispatch(store: &PhotoStore, command: DbCommand) {
    match command {
        DbCommand::TrainingUpsertFrame {
            filename,
            width,
            height,
            captured_at,
            reply,
        } => send_reply(
            reply,
            store.upsert_training_frame(&filename, width, height, captured_at.as_deref()),
        ),
        DbCommand::TrainingListFrames {
            status,
            limit,
            offset,
            reply,
        } => send_reply(
            reply,
            store.list_training_frames(status.as_deref(), limit, offset),
        ),
        DbCommand::TrainingGetFrame { id, reply } => {
            send_reply(reply, store.get_training_frame(id))
        }
        DbCommand::TrainingUpdateStatus { id, status, reply } => {
            send_reply(reply, store.update_training_frame_status(id, &status))
        }
        DbCommand::TrainingListAnnotations { frame_id, reply } => {
            send_reply(reply, store.list_training_annotations(frame_id))
        }
        DbCommand::TrainingReplaceAnnotations {
            frame_id,
            annotations,
            reply,
        } => send_reply(
            reply,
            store.replace_training_annotations(frame_id, &annotations),
        ),
        DbCommand::TrainingDeleteAnnotation { id, reply } => {
            send_reply(reply, store.delete_training_annotation(id))
        }
        DbCommand::TrainingDeleteRejected { reply } => {
            send_reply(reply, store.delete_rejected_frames())
        }
        DbCommand::TrainingStats { reply } => send_reply(reply, store.training_stats()),
        DbCommand::TrainingExport { reply } => send_reply(reply, store.export_training_dataset()),
        DbCommand::TrainingSetBgRef {
            id,
            is_bg_ref,
            reply,
        } => send_reply(reply, store.set_bg_ref(id, is_bg_ref)),
        DbCommand::TrainingListBgRefFrames { reply } => {
            send_reply(reply, store.list_bg_ref_frames())
        }
        DbCommand::TrainingBgRefCount { reply } => send_reply(reply, store.bg_ref_count()),
        DbCommand::TrainingBulkUpdateBgScores { scores, reply } => {
            send_reply(reply, store.bulk_update_bg_scores(&scores))
        }
        DbCommand::TrainingBulkRejectByScore { threshold, reply } => {
            send_reply(reply, store.bulk_reject_by_score(threshold))
        }
        DbCommand::InsertPhoto { .. }
        | DbCommand::GetPhoto { .. }
        | DbCommand::GetPhotoById { .. }
        | DbCommand::ListPhotos { .. }
        | DbCommand::ListPendingFilenames { .. }
        | DbCommand::ApplyVlmResult { .. }
        | DbCommand::OverrideValidation { .. }
        | DbCommand::RecordVlmFailure { .. }
        | DbCommand::Stats { .. }
        | DbCommand::GetVlmAttempts { .. }
        | DbCommand::IngestWithDetections { .. }
        | DbCommand::GetDetections { .. }
        | DbCommand::UpdateDetectionOverride { .. }
        | DbCommand::UpdatePetId { .. }
        | DbCommand::UpdateBehavior { .. }
        | DbCommand::DistinctPetIds { .. }
        | DbCommand::DistinctBehaviors { .. }
        | DbCommand::CaptionsForDate { .. }
        | DbCommand::ListUndetectedPhotos { .. }
        | DbCommand::MarkDetected { .. }
        | DbCommand::RecordEmptyLevel2 { .. }
        | DbCommand::GetEditHistory { .. }
        | DbCommand::GetBboxesForPhotos { .. } => {
            unreachable!("album command reached training dispatcher")
        }
    }
}
