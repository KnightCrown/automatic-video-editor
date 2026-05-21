use crate::types::{Transcript, TranscriptSegment, TranscriptWord};
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;

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

pub fn find_fuzzy_phrase_occurrences(words: &[TranscriptWord], phrase: &str) -> Vec<WordOccurrence> {
    let needle: Vec<String> = phrase
        .split_whitespace()
        .map(normalize_token)
        .filter(|t| !t.is_empty())
        .collect();
    if needle.is_empty() || words.is_empty() {
        return Vec::new();
    }

    let haystack: Vec<String> = words.iter().map(|w| normalize_token(&w.text)).collect();
    let matcher = SkimMatcherV2::default().ignore_case();
    let needle_text = needle.join(" ");
    let min_window = needle.len().saturating_sub(2).max(1);
    let max_window = (needle.len() + 5).min(words.len());
    let mut scored: Vec<(i64, usize, usize, WordOccurrence)> = Vec::new();

    for start in 0..haystack.len() {
        for len in min_window..=max_window {
            let end = start + len;
            if end > haystack.len() {
                break;
            }
            let window_tokens = &haystack[start..end];
            if window_tokens.iter().all(|t| t.is_empty()) {
                continue;
            }
            let window_text = window_tokens.join(" ");
            let Some(fuzzy_score) = matcher.fuzzy_match(&window_text, &needle_text) else {
                continue;
            };
            let overlap = needle
                .iter()
                .filter(|token| window_tokens.iter().any(|w| w == *token))
                .count() as i64;
            let token_score = overlap * 30 - (needle.len() as i64 - len as i64).abs() * 8;
            let score = fuzzy_score + token_score;
            let required_overlap = if needle.len() <= 2 {
                needle.len()
            } else {
                ((needle.len() as f64) * 0.55).ceil() as usize
            } as i64;
            let threshold = 16 + (needle_text.len() as i64 / 2);
            if overlap < required_overlap || score < threshold {
                continue;
            }
            let end_idx = end - 1;
            scored.push((
                score,
                start,
                end_idx,
                WordOccurrence {
                    start_ms: words[start].start_ms,
                    end_ms: words[end_idx].end_ms,
                    matched_text: words[start..=end_idx]
                        .iter()
                        .map(|w| w.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                    excerpt: excerpt_around_index(words, start, 8),
                },
            ));
        }
    }

    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    let mut hits: Vec<WordOccurrence> = Vec::new();
    for (_, _, _, occurrence) in scored {
        if hits.iter().any(|h| h.start_ms.abs_diff(occurrence.start_ms) < 900) {
            continue;
        }
        hits.push(occurrence);
        if hits.len() >= 12 {
            break;
        }
    }
    hits.sort_by_key(|h| h.start_ms);
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
