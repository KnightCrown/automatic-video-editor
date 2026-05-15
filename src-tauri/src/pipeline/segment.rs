use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::types::{OverlayCandidate, OverlayCandidateStatus, Transcript, TranscriptSegment};

const VISUAL_KEYWORDS: &[&str] = &[
    "rainbow", "ark", "angel", "bible", "cross", "church", "star", "sun", "moon", "tree",
    "flower", "animal", "lion", "sheep", "fish", "bird", "mountain", "river", "ocean", "boat",
    "house", "castle", "crown", "heart", "light", "fire", "water", "cloud", "jesus", "god",
    "pray", "song", "dance", "run", "jump", "smile", "friend", "family", "color", "red",
    "blue", "green", "yellow", "big", "small", "look", "see", "watch", "draw", "paint",
];

const FILLER_WORDS: &[&str] = &["um", "uh", "okay", "ok", "so", "well", "like", "you know"];

pub fn select_overlay_candidates(
    transcript: &Transcript,
    max_candidates: u32,
) -> Vec<OverlayCandidate> {
    let chunks = build_chunks(transcript);
    let mut scored: Vec<(u32, Vec<String>, TranscriptSegment)> = chunks
        .into_iter()
        .map(|chunk| {
            let (score, reasons) = score_chunk(&chunk.text);
            (score, reasons, chunk)
        })
        .filter(|(score, _, _)| *score > 0)
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0));

    let mut selected = Vec::new();
    let mut used_ranges: Vec<(u64, u64)> = Vec::new();

    for (score, reasons, chunk) in scored {
        if selected.len() >= max_candidates as usize {
            break;
        }
        if overlaps_existing(chunk.start_ms, chunk.end_ms, &used_ranges) {
            continue;
        }
        if is_duplicate_of_selected(&chunk.text, &selected) {
            continue;
        }
        used_ranges.push((chunk.start_ms, chunk.end_ms));
        selected.push(OverlayCandidate {
            id: Uuid::new_v4().to_string(),
            video_id: transcript.video_id.clone(),
            start_ms: chunk.start_ms,
            end_ms: chunk.end_ms,
            transcript_excerpt: chunk.text.trim().to_string(),
            score,
            reasons,
            status: OverlayCandidateStatus::Pending,
        });
    }

    selected
}

fn build_chunks(transcript: &Transcript) -> Vec<TranscriptSegment> {
    if transcript.segments.is_empty() {
        if transcript.full_text.trim().is_empty() {
            return Vec::new();
        }
        return vec![TranscriptSegment {
            start_ms: 0,
            end_ms: 0,
            text: transcript.full_text.clone(),
        }];
    }

    let mut chunks = Vec::new();
    let mut current_text = String::new();
    let mut start_ms = transcript.segments[0].start_ms;
    let mut end_ms = transcript.segments[0].end_ms;

    for seg in &transcript.segments {
        let gap = seg.start_ms.saturating_sub(end_ms);
        let duration = end_ms.saturating_sub(start_ms);
        let next_duration = seg.end_ms.saturating_sub(start_ms);

        if gap > 400 || duration >= 20_000 || (duration >= 8_000 && seg.text.ends_with('.')) {
            if !current_text.trim().is_empty() {
                chunks.push(TranscriptSegment {
                    start_ms,
                    end_ms,
                    text: current_text.trim().to_string(),
                });
            }
            current_text = seg.text.clone();
            start_ms = seg.start_ms;
            end_ms = seg.end_ms;
            continue;
        }

        if !current_text.is_empty() {
            current_text.push(' ');
        }
        current_text.push_str(&seg.text);
        end_ms = seg.end_ms;

        if next_duration >= 20_000 {
            chunks.push(TranscriptSegment {
                start_ms,
                end_ms,
                text: current_text.trim().to_string(),
            });
            current_text.clear();
        }
    }

    if !current_text.trim().is_empty() {
        chunks.push(TranscriptSegment {
            start_ms,
            end_ms,
            text: current_text.trim().to_string(),
        });
    }

    chunks
}

fn score_chunk(text: &str) -> (u32, Vec<String>) {
    let lower = text.to_lowercase();
    let mut score: u32 = 10;
    let mut reasons = Vec::new();

    for kw in VISUAL_KEYWORDS {
        if lower.contains(kw) {
            score += 15;
            reasons.push(format!("visual_keyword:{kw}"));
        }
    }

    if text.contains('?') {
        score += 12;
        reasons.push("question".to_string());
    }
    if text.contains('!') {
        score += 10;
        reasons.push("exclamation".to_string());
    }

    for starter in ["look", "let's", "remember", "imagine", "can you", "today we"] {
        if lower.starts_with(starter) {
            score += 8;
            reasons.push(format!("imperative:{starter}"));
            break;
        }
    }

    let words: Vec<&str> = lower.split_whitespace().collect();
    if !words.is_empty() {
        let filler_count = words
            .iter()
            .filter(|w| FILLER_WORDS.contains(w))
            .count();
        if filler_count * 2 >= words.len() {
            score = score.saturating_sub(25);
            reasons.push("mostly_filler".to_string());
        }
    }

    if text.len() < 12 {
        score = score.saturating_sub(20);
        reasons.push("too_short".to_string());
    }

    (score, reasons)
}

fn overlaps_existing(start: u64, end: u64, used: &[(u64, u64)]) -> bool {
    used.iter().any(|(s, e)| start < *e && end > *s)
}

fn is_duplicate_of_selected(text: &str, selected: &[OverlayCandidate]) -> bool {
    let words = bag_of_words(text);
    if words.is_empty() {
        return true;
    }
    selected.iter().any(|c| {
        let other = bag_of_words(&c.transcript_excerpt);
        cosine_similarity(&words, &other) > 0.85
    })
}

fn bag_of_words(text: &str) -> HashMap<String, u32> {
    let mut map = HashMap::new();
    for w in text.to_lowercase().split_whitespace() {
        if w.len() > 2 {
            *map.entry(w.to_string()).or_insert(0) += 1;
        }
    }
    map
}

fn cosine_similarity(a: &HashMap<String, u32>, b: &HashMap<String, u32>) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut norm_a = 0f32;
    let mut norm_b = 0f32;
    let keys: HashSet<_> = a.keys().chain(b.keys()).collect();
    for k in keys {
        let av = *a.get(k).unwrap_or(&0) as f32;
        let bv = *b.get(k).unwrap_or(&0) as f32;
        dot += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}
