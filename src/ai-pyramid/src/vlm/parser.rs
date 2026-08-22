use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct VlmResponse {
    // JSON key from Qwen3.5 is "cat"; legacy/alternate spellings accepted for forward compat.
    #[serde(
        rename = "cat",
        alias = "is_valid",
        alias = "isvalid",
        alias = "cat_visible",
        alias = "catvisible"
    )]
    pub is_valid: bool,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub behavior: String,
}

const BEHAVIOR_ENUM: [&str; 8] = [
    "eating", "drinking", "sleeping", "playing", "resting", "moving", "grooming", "other",
];

pub fn parse_vlm_response(raw: &str) -> Result<VlmResponse, String> {
    let json_str = extract_json_object(raw)
        .ok_or_else(|| format!("JSON parse error: no JSON object found, raw: {raw}"))?;
    if let Ok(resp) = serde_json::from_str::<VlmResponse>(json_str) {
        return Ok(resp);
    }

    // Qwen3.5-2B occasionally drops the closing quote on a behavior enum.
    let mut fixed = json_str.to_string();
    let needle = r#""behavior":"#;
    for value in BEHAVIOR_ENUM {
        for separator in [" ", ""] {
            for tail in ["}", ",", " "] {
                let from = format!("{needle}{separator}{value}{tail}");
                let to = format!("{needle}{separator}\"{value}\"{tail}");
                fixed = fixed.replace(&from, &to);
            }
        }
    }
    serde_json::from_str(&fixed).map_err(|error| format!("JSON parse error: {error}, raw: {raw}"))
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    let mut depth = 0i32;
    let mut start = None;
    let mut in_string = false;
    let mut escape = false;
    for (index, &byte) in bytes.iter().enumerate() {
        if in_string {
            if escape {
                escape = false;
            } else if byte == b'\\' {
                escape = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = Some(index);
                }
                depth += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0
                    && let Some(start) = start
                {
                    return Some(&raw[start..=index]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Remove Arabic Unicode block characters injected by GPTQ Int4 degradation.
pub(super) fn strip_arabic(text: &str) -> String {
    text.chars()
        .filter(|&character| !('\u{0600}'..='\u{06FF}').contains(&character))
        .collect()
}

/// Remove leaked `<think>...</think>` reasoning blocks.
pub(super) fn strip_think(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        output.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => {
                rest = &rest[start + end + "</think>".len()..];
            }
            None => {
                rest = "";
                break;
            }
        }
    }
    output.push_str(rest);
    output.trim().to_string()
}
