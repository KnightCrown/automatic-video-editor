use crate::pipeline::word_timing::{
    find_fuzzy_phrase_occurrences, find_phrase_occurrences, find_word_occurrences, words_for_matching,
    WordOccurrence,
};
use crate::types::Transcript;

/// Phrases ordered longest-first so "goodbye" wins over "bye" at the same moment.
const SIGN_OFF_PHRASES: &[&str] = &[
    "thank you for watching",
    "thanks for watching",
    "see you next time",
    "see you later",
    "see you soon",
    "until next time",
    "that's all for today",
    "that's all for now",
    "have a great day",
    "have a good day",
    "we'll see you",
    "good night",
    "goodnight",
    "good bye",
    "goodbye",
    "bye bye",
    "see ya",
    "see you",
    "god bless",
    "peace out",
    "take care",
    "bye",
];

const MIN_TAIL_MS: u64 = 120_000;
const CLOSING_TAIL_PCT: u64 = 25;

#[derive(Debug, Clone)]
pub struct SignOffMatch {
    pub end_ms: u64,
    pub matched_text: String,
    pub excerpt: String,
}

pub fn closing_window_start_ms(video_duration_ms: u64) -> u64 {
    let pct_start = video_duration_ms.saturating_mul(100 - CLOSING_TAIL_PCT) / 100;
    let tail_start = video_duration_ms.saturating_sub(MIN_TAIL_MS);
    pct_start.max(tail_start).min(video_duration_ms)
}

pub fn detect_episode_sign_off_end_ms(
    transcript: &Transcript,
    video_duration_ms: u64,
) -> Option<u64> {
    detect_episode_sign_off(transcript, video_duration_ms).map(|m| m.end_ms)
}

pub fn detect_episode_sign_off(
    transcript: &Transcript,
    video_duration_ms: u64,
) -> Option<SignOffMatch> {
    let window_start = closing_window_start_ms(video_duration_ms);
    let words = words_for_matching(transcript);

    let mut best: Option<(SignOffMatch, usize)> = None;

    for phrase in SIGN_OFF_PHRASES.iter() {
        let hits = matching_sign_off_hits(&words, phrase);
        for hit in hits {
            if hit.end_ms < window_start {
                continue;
            }
            let candidate = SignOffMatch {
                end_ms: hit.end_ms.min(video_duration_ms),
                matched_text: hit.matched_text.clone(),
                excerpt: hit.excerpt.clone(),
            };
            let phrase_len = phrase.split_whitespace().count();
            let replace = match &best {
                None => true,
                Some((current, current_phrase_len)) => {
                    candidate.end_ms > current.end_ms
                        || (candidate.end_ms == current.end_ms && phrase_len > *current_phrase_len)
                }
            };
            if replace {
                best = Some((candidate, phrase_len));
            }
        }
    }

    if best.is_some() {
        return best.map(|(m, _)| m);
    }

    segment_sign_off_fallback(transcript, window_start, video_duration_ms)
}

fn matching_sign_off_hits(words: &[crate::types::TranscriptWord], phrase: &str) -> Vec<WordOccurrence> {
    let exact = find_phrase_occurrences(words, phrase);
    if !exact.is_empty() {
        return exact;
    }
    if phrase.split_whitespace().count() == 1 {
        return find_word_occurrences(words, phrase);
    }
    find_fuzzy_phrase_occurrences(words, phrase)
}

fn segment_sign_off_fallback(
    transcript: &Transcript,
    window_start: u64,
    video_duration_ms: u64,
) -> Option<SignOffMatch> {
    for seg in transcript.segments.iter().rev() {
        if seg.end_ms < window_start {
            break;
        }
        let normalized = seg.text.to_lowercase();
        for phrase in SIGN_OFF_PHRASES {
            if contains_sign_off_phrase(&normalized, phrase) {
                return Some(SignOffMatch {
                    end_ms: seg.end_ms.min(video_duration_ms),
                    matched_text: phrase.to_string(),
                    excerpt: seg.text.clone(),
                });
            }
        }
    }
    None
}

fn contains_sign_off_phrase(text: &str, phrase: &str) -> bool {
    if phrase.split_whitespace().count() > 1 {
        return text.contains(phrase);
    }
    text.split_whitespace().any(|word| {
        word.chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
            .eq_ignore_ascii_case(phrase)
    })
}

pub fn resolve_content_end_ms(
    transcript: &Transcript,
    video_duration_ms: u64,
    llm_content_end_ms: Option<u64>,
    content_start_ms: u64,
) -> u64 {
    let fallback = transcript
        .segments
        .last()
        .map(|s| s.end_ms)
        .unwrap_or(video_duration_ms)
        .min(video_duration_ms);

    let sign_off_end = detect_episode_sign_off_end_ms(transcript, video_duration_ms);

    let end = match (sign_off_end, llm_content_end_ms) {
        (Some(sign_off), Some(llm)) => {
            if sign_off <= llm {
                sign_off
            } else if llm >= content_start_ms.saturating_add(500) {
                llm
            } else {
                sign_off
            }
        }
        (Some(sign_off), None) => sign_off,
        (None, Some(llm)) => llm,
        (None, None) => fallback,
    };

    end.clamp(
        content_start_ms.saturating_add(500),
        video_duration_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{TranscriptSegment, TranscriptWord};

    fn word(start_ms: u64, text: &str) -> TranscriptWord {
        TranscriptWord {
            start_ms,
            end_ms: start_ms + 400,
            text: text.to_string(),
        }
    }

    #[test]
    fn detects_final_bye_in_closing_portion() {
        let transcript = Transcript {
            video_id: "v1".to_string(),
            video_path: "episode.mp4".to_string(),
            full_text: String::new(),
            segments: vec![],
            words: Some(vec![
                word(1_000, "Hello"),
                word(58_000, "Thanks"),
                word(58_500, "everyone"),
                word(59_000, "bye"),
            ]),
            probed_video_stream_start_sec: None,
            probed_audio_stream_start_sec: None,
            applied_transcript_timing_offset_ms: None,
        };

        let sign_off = detect_episode_sign_off(&transcript, 60_000).expect("sign-off");
        assert_eq!(sign_off.end_ms, 59_400);
        assert_eq!(sign_off.matched_text, "bye");
    }

    #[test]
    fn ignores_early_bye_and_uses_late_goodbye() {
        let transcript = Transcript {
            video_id: "v1".to_string(),
            video_path: "episode.mp4".to_string(),
            full_text: String::new(),
            segments: vec![],
            words: Some(vec![
                word(5_000, "bye"),
                word(55_000, "Okay"),
                word(56_000, "goodbye"),
                word(56_500, "everyone"),
            ]),
            probed_video_stream_start_sec: None,
            probed_audio_stream_start_sec: None,
            applied_transcript_timing_offset_ms: None,
        };

        let sign_off = detect_episode_sign_off(&transcript, 60_000).expect("sign-off");
        assert!(sign_off.end_ms >= 56_000);
        assert!(sign_off.matched_text.contains("goodbye"));
    }

    #[test]
    fn resolve_content_end_prefers_sign_off_over_late_llm_end() {
        let transcript = Transcript {
            video_id: "v1".to_string(),
            video_path: "episode.mp4".to_string(),
            full_text: String::new(),
            segments: vec![],
            words: Some(vec![word(59_000, "bye")]),
            probed_video_stream_start_sec: None,
            probed_audio_stream_start_sec: None,
            applied_transcript_timing_offset_ms: None,
        };

        let end = resolve_content_end_ms(&transcript, 60_000, Some(60_000), 0);
        assert_eq!(end, 59_400);
    }
}
