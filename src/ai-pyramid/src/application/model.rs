use crate::db::{Photo, PhotoFilter, Stats};
use chrono::NaiveDateTime;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventStatusFilter {
    All,
    Valid,
    Invalid,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventQuery {
    pub status: EventStatusFilter,
    pub pet_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub search: Option<String>,
    pub behavior: Option<String>,
    pub yolo_classes: Vec<String>,
}

impl Default for EventQuery {
    fn default() -> Self {
        Self {
            status: EventStatusFilter::All,
            pet_id: None,
            limit: None,
            offset: None,
            search: None,
            behavior: None,
            yolo_classes: Vec::new(),
        }
    }
}

impl EventQuery {
    pub(crate) fn to_photo_filter(&self) -> PhotoFilter {
        PhotoFilter {
            is_valid: match self.status {
                EventStatusFilter::Valid => Some(true),
                EventStatusFilter::Invalid => Some(false),
                EventStatusFilter::All | EventStatusFilter::Pending => None,
            },
            is_pending: matches!(self.status, EventStatusFilter::Pending),
            pet_id: self.pet_id.clone(),
            limit: self.limit,
            offset: self.offset,
            search: self.search.clone(),
            behavior: self.behavior.clone(),
            yolo_classes: self.yolo_classes.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventStatus {
    Valid,
    Invalid,
    Pending,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventSummary {
    pub id: i64,
    pub source_filename: String,
    pub observed_at: String,
    pub summary: Option<String>,
    pub status: EventStatus,
    pub pet_id: Option<String>,
    pub behavior: Option<String>,
}

impl EventSummary {
    pub fn summary_display(&self) -> &str {
        self.summary.as_deref().unwrap_or("")
    }

    pub fn pet_id_display(&self) -> &str {
        self.pet_id.as_deref().unwrap_or("")
    }

    pub fn behavior_display(&self) -> &str {
        self.behavior.as_deref().unwrap_or("")
    }

    pub fn status_class(&self) -> &str {
        match self.status {
            EventStatus::Valid => "valid",
            EventStatus::Invalid => "invalid",
            EventStatus::Pending => "pending",
        }
    }
}

impl From<Photo> for EventSummary {
    fn from(photo: Photo) -> Self {
        let status = match photo.is_valid {
            Some(true) => EventStatus::Valid,
            Some(false) => EventStatus::Invalid,
            None => EventStatus::Pending,
        };
        Self {
            id: photo.id,
            source_filename: photo.filename,
            observed_at: photo.captured_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
            summary: photo.caption,
            status,
            pet_id: photo.pet_id,
            behavior: photo.behavior,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityStats {
    pub total_events: i64,
    pub confirmed_events: i64,
    pub rejected_events: i64,
    pub pending_events: i64,
}

impl From<Stats> for ActivityStats {
    fn from(stats: Stats) -> Self {
        Self {
            total_events: stats.total,
            confirmed_events: stats.valid,
            rejected_events: stats.invalid,
            pending_events: stats.pending,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ObservationInput {
    pub source_filename: String,
    pub captured_at: NaiveDateTime,
    pub pet_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ObservationResult {
    pub source_filename: String,
    pub is_valid: bool,
    pub summary: String,
    pub behavior: String,
}
