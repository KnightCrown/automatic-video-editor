use crate::types::{Transcript, TranscriptSegment, TranscriptWord};

/// Spread words evenly across a segment when ASR only provides sentence-level timings.
pub fn interpolate_words_in_segment(seg: &TranscriptSegment) -> Vec<TranscriptWord> {
    let words: Vec<&str> = seg.text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let n = words.len() as u64;
    let dur = seg.end_ms.saturating_sub(seg.start_ms).max(1);
    words
        .into_iter()
        .enumerate()
        .map(|(i, w)| {
            let t0 = seg.start_ms + dur * (i as u64) / n;
            let t1 = seg.start_ms + dur * ((i as u64) + 1) / n;
            TranscriptWord {
                start_ms: t0,
                end_ms: t1.max(t0 + 1),
                text: w.to_string(),
            }
        })
        .collect()
}

pub fn build_interpolated_words(transcript: &Transcript) -> Vec<TranscriptWord> {
    transcript
        .segments
        .iter()
        .flat_map(interpolate_words_in_segment)
        .collect()
}

pub fn normalize_token(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

pub fn words_for_matching(transcript: &Transcript) -> Vec<TranscriptWord> {
    if let Some(words) = &transcript.words {
        if words.len() >= transcript.segments.len() {
            return words.clone();
        }
    }
    build_interpolated_words(transcript)
}

#[derive(Clone)]
pub struct WordOccurrence {
    pub start_ms: u64,
    pub end_ms: u64,
    pub matched_text: String,
    pub excerpt: String,
}

pub fn find_word_occurrences(words: &[TranscriptWord], trigger: &str) -> Vec<WordOccurrence> {
    let needle = normalize_token(trigger);
    if needle.is_empty() {
        return Vec::new();
    }

    let mut hits = Vec::new();
    for (i, word) in words.iter().enumerate() {
        if normalize_token(&word.text) != needle {
            continue;
        }
        let excerpt = excerpt_around_index(words, i, 6);
        hits.push(WordOccurrence {
            start_ms: word.start_ms,
            end_ms: word.end_ms,
            matched_text: word.text.clone(),
            excerpt,
        });
    }
    hits
}

pub fn find_phrase_occurrences(words: &[TranscriptWord], phrase: &str) -> Vec<WordOccurrence> {
    let needle: Vec<String> = phrase
        .split_whitespace()
        .map(normalize_token)
        .filter(|t| !t.is_empty())
        .collect();
    if needle.is_empty() {
        return Vec::new();
    }

    let haystack: Vec<String> = words.iter().map(|w| normalize_token(&w.text)).collect();
    let mut hits = Vec::new();
    for start in 0..haystack.len() {
        if start + needle.len() > haystack.len() {
            break;
        }
        if haystack[start..start + needle.len()] != needle {
            continue;
        }
        let end_idx = start + needle.len() - 1;
        hits.push(WordOccurrence {
            start_ms: words[start].start_ms,
            end_ms: words[end_idx].end_ms,
            matched_text: words[start..=end_idx]
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            excerpt: excerpt_around_index(words, start, 8),
        });
    }
    hits
}

pub fn excerpt_around_index(words: &[TranscriptWord], center: usize, radius: usize) -> String {
    let start = center.saturating_sub(radius);
    let end = (center + radius + 1).min(words.len());
    words[start..end]
        .iter()
        .map(|w| w.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}
