#[derive(Debug, Clone, serde::Serialize)]
pub struct PetEvent {
    pub source_filename: String,
    pub is_valid: bool,
    pub summary: String,
    pub behavior: String,
    pub pet_id: Option<String>,
}
