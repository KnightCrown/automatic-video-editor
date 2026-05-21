use std::path::{Path, PathBuf};

use crate::pipeline::word_timing::{
    find_fuzzy_phrase_occurrences, find_phrase_occurrences, find_word_occurrences, normalize_token,
    words_for_matching, WordOccurrence,
};
use crate::types::{AssetPlacement, ProjectSettings, ProposedAssetTrigger, Transcript};
use crate::video::encoders::probe_video_duration_sec;
use crate::video::extensions::{is_video_file_extension, timeline_asset_kind_for_extension};

const DEFAULT_TRIGGER_DURATION_MS: u64 = 2_000;
const DEFAULT_IMAGE_ASSET_DURATION_MS: u64 = 5_000;
const MAX_OVERLAY_TRIGGER_DURATION_MS: u64 = 180_000;

#[derive(Debug, Clone)]
pub struct TimelineAssetFile {
    pub file_name: String,
    pub asset_kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScheduleAnchor {
    None,
    Start,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TriggerBehavior {
    Instant,
    DurationBased,
    Stateful,
}

#[derive(Debug, Clone)]
struct AssetRule {
    file_name: String,
    asset_kind: String,
    placement_kind: String,
    trigger_words: Vec<String>,
    trigger_phrases: Vec<String>,
    end_trigger_phrases: Vec<String>,
    duration_ms: Option<u64>,
    full_screen: bool,
    timeline_mode: String,
    render_mode: String,
    schedule_anchor: ScheduleAnchor,
    trigger_behavior: TriggerBehavior,
    prefer_late: bool,
    start_at_match_end: bool,
}

pub fn list_timeline_assets(asset_folder: &Path) -> Vec<TimelineAssetFile> {
    let Ok(read_dir) = std::fs::read_dir(asset_folder) else {
        return Vec::new();
    };
    let mut files: Vec<TimelineAssetFile> = read_dir
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if !path.is_file() {
                return None;
            }
            let ext = path.extension()?.to_str()?;
            let asset_kind = timeline_asset_kind_for_extension(ext)?;
            let file_name = path.file_name()?.to_str()?.to_string();
            Some(TimelineAssetFile {
                file_name,
                asset_kind: asset_kind.to_string(),
            })
        })
        .collect();
    files.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    files
}

pub fn list_timeline_asset_file_names(asset_folder: &Path) -> Vec<String> {
    list_timeline_assets(asset_folder)
        .into_iter()
        .map(|a| a.file_name)
        .collect()
}

#[allow(dead_code)]
pub fn list_video_assets(asset_folder: &Path) -> Vec<String> {
    let Ok(read_dir) = std::fs::read_dir(asset_folder) else {
        return Vec::new();
    };
    let mut files: Vec<String> = read_dir
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if !path.is_file() {
                return None;
            }
            let ext = path.extension()?.to_str()?.to_lowercase();
            if !is_video_file_extension(&ext) {
                return None;
            }
            path.file_name()?.to_str().map(|s| s.to_string())
        })
        .collect();
    files.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    files
}

fn filename_schedule_anchor(file_name: &str) -> Option<ScheduleAnchor> {
    let stem = asset_stem(&file_name.to_lowercase());
    if matches!(
        stem.as_str(),
        "intro" | "opener" | "opening" | "title" | "pre-roll" | "preroll" | "bumper"
    ) || (stem.contains("intro") && !stem.contains("outro")) {
        return Some(ScheduleAnchor::Start);
    }
    if matches!(
        stem.as_str(),
        "outro" | "closer" | "closing" | "endcard" | "end-card"
    ) || stem.contains("outro") {
        return Some(ScheduleAnchor::End);
    }
    None
}

pub(crate) fn is_scheduled_placement_kind(kind: &str) -> bool {
    matches!(
        kind,
        "scheduled_start" | "scheduled_end" | "intro" | "outro"
    )
}

fn infer_rules_for_asset(asset: &TimelineAssetFile, show_context: &str) -> AssetRule {
    let lower_name = asset.file_name.to_lowercase();
    let ctx = show_context.to_lowercase();
    let asset_window = context_window_for_asset(&ctx, &lower_name);
    let asset_clause = context_clause_for_asset(&ctx, &lower_name);
    let stem = asset_stem(&lower_name);
    let filename_anchor = filename_schedule_anchor(&lower_name);

    let end_trigger_phrases = extract_until_phrases(&asset_window);
    let trigger_phrases = extract_trigger_phrases_for_asset(&ctx, &lower_name);
    let mut trigger_words = Vec::new();
    if let Some(word) = extract_trigger_word_for_asset(&ctx, &lower_name) {
        trigger_words.push(word);
    }
    if filename_anchor.is_none()
        && trigger_words.is_empty()
        && trigger_phrases.is_empty()
        && stem.len() >= 2
    {
        for marker in [
            format!("says {stem}"),
            format!("say {stem}"),
            format!("hear {stem}"),
            format!("hears {stem}"),
            format!("mentions {stem}"),
        ] {
            if contains_word_phrase(&asset_window, &marker) {
                trigger_words.push(stem.clone());
                break;
            }
        }
    }

    let has_asset_trigger = !trigger_words.is_empty() || !trigger_phrases.is_empty();
    let schedule_anchor = filename_anchor.unwrap_or_else(|| {
        if has_asset_trigger {
            ScheduleAnchor::None
        } else {
            infer_schedule_anchor(&asset_window)
        }
    });
    let overlay_requested = contains_any(
        &asset_clause,
        &[
            " as an overlay",
            " overlay",
            "overlay position",
            " on screen",
            " keep it visible",
            " keep on screen",
            " show ",
            " display ",
        ],
    );
    let full_screen = contains_any(
        &asset_clause,
        &[
            "full-screen",
            "full screen",
            "fullscreen",
            "full-frame",
            "full frame",
            "not as an overlay",
        ],
    );
    let insert_requested = full_screen
        || schedule_anchor != ScheduleAnchor::None
        || contains_any(
            &asset_clause,
            &[
                "not as an overlay",
                "continue after",
                "continues after",
                "resume after",
                "then continue",
                "then resumes",
                "play before",
                "play after",
                "insert ",
                "cut away",
            ],
        );

    let timeline_mode = if schedule_anchor != ScheduleAnchor::None {
        "insert".to_string()
    } else if insert_requested && !overlay_requested {
        "insert".to_string()
    } else {
        "overlay".to_string()
    };
    let render_mode = timeline_mode.clone();
    let placement_kind = match schedule_anchor {
        ScheduleAnchor::Start => "scheduled_start",
        ScheduleAnchor::End => "scheduled_end",
        ScheduleAnchor::None => "trigger",
    }
    .to_string();
    let trigger_behavior = if !end_trigger_phrases.is_empty() {
        TriggerBehavior::Stateful
    } else if timeline_mode == "insert" {
        TriggerBehavior::Instant
    } else {
        TriggerBehavior::DurationBased
    };
    let prefer_late = contains_any(
        &asset_window,
        &[
            "towards the end",
            "toward the end",
            "near the end",
            "late in",
            "closing",
            "final ",
            "ending",
        ],
    );
    let start_at_match_end = contains_any(
        &asset_window,
        &[
            "immediately after",
            "right after",
            "after the phrase",
            "after it says",
            "after they say",
            "after the user says",
            "after the speaker says",
            "after the line",
            "when the phrase completes",
            "once the phrase completes",
        ],
    );

    AssetRule {
        file_name: asset.file_name.clone(),
        asset_kind: asset.asset_kind.clone(),
        placement_kind,
        trigger_words,
        trigger_phrases,
        end_trigger_phrases,
        duration_ms: None,
        full_screen,
        timeline_mode,
        render_mode,
        schedule_anchor,
        trigger_behavior,
        prefer_late,
        start_at_match_end,
    }
}

fn infer_schedule_anchor(window: &str) -> ScheduleAnchor {
    let starts = [
        " at the start",
        " at the beginning",
        "from the start",
        "start with",
        "start every",
        "starts with",
        "begin with",
        "begin every",
        "begins with",
        "first play",
        "play first",
        "before the episode",
        "before the main video",
        "prepend",
    ];
    let ends = [
        " at the end",
        "after the episode",
        "after the main video",
        "after the video",
        "after the content",
        "end with",
        "ends with",
        "finish with",
        "last play",
        "play last",
        "append",
    ];

    let first_start = starts.iter().filter_map(|m| window.find(m)).min();
    let first_end = ends.iter().filter_map(|m| window.find(m)).min();
    match (first_start, first_end) {
        (Some(s), Some(e)) if s <= e => ScheduleAnchor::Start,
        (Some(_), None) => ScheduleAnchor::Start,
        (Some(_), Some(_)) => ScheduleAnchor::End,
        (None, Some(_)) => ScheduleAnchor::End,
        (None, None) => ScheduleAnchor::None,
    }
}

fn contains_any(text: &str, markers: &[&str]) -> bool {
    markers.iter().any(|marker| text.contains(marker))
}

fn contains_word_phrase(text: &str, phrase: &str) -> bool {
    if phrase.is_empty() {
        return false;
    }
    let mut start = 0;
    while let Some(idx) = text[start..].find(phrase) {
        let abs = start + idx;
        let before_ok = abs == 0 || !text.as_bytes()[abs - 1].is_ascii_alphanumeric();
        let after_idx = abs + phrase.len();
        let after_ok =
            after_idx >= text.len() || !text.as_bytes()[after_idx].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
        if start >= text.len() {
            break;
        }
    }
    false
}

fn asset_stem(asset_name: &str) -> String {
    Path::new(asset_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(asset_name)
        .to_string()
}

fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut boundary = 0;
    for (i, _) in s.char_indices() {
        if i > idx {
            break;
        }
        boundary = i;
    }
    boundary
}

fn ceil_char_boundary(s: &str, idx: usize) -> usize {
    for (i, _) in s.char_indices() {
        if i >= idx {
            return i;
        }
    }
    s.len()
}

fn context_window_for_asset(ctx: &str, asset_name: &str) -> String {
    let stem = asset_stem(asset_name);
    let idx = ctx.find(asset_name).or_else(|| ctx.find(&stem));
    let Some(idx) = idx else {
        return ctx.to_string();
    };
    let start = floor_char_boundary(ctx, idx.saturating_sub(800));
    let end = ceil_char_boundary(ctx, (idx + asset_name.len() + 800).min(ctx.len()));
    ctx[start..end].to_string()
}

fn context_clause_for_asset(ctx: &str, asset_name: &str) -> String {
    let stem = asset_stem(asset_name);
    let idx = ctx.find(asset_name).or_else(|| ctx.find(&stem));
    let Some(idx) = idx else {
        return context_window_for_asset(ctx, asset_name);
    };
    let hard_start = floor_char_boundary(ctx, idx.saturating_sub(260));
    let hard_end = ceil_char_boundary(ctx, (idx + asset_name.len() + 260).min(ctx.len()));
    let around = &ctx[hard_start..hard_end];
    let relative_idx = idx.saturating_sub(hard_start);
    let clause_start = around[..relative_idx]
        .rfind(|c| matches!(c, '.' | '\n' | ';'))
        .map(|i| i + 1)
        .unwrap_or(0);
    let clause_end = around[relative_idx..]
        .find(|c| matches!(c, '.' | '\n' | ';'))
        .map(|i| relative_idx + i)
        .unwrap_or(around.len());
    around[clause_start..clause_end].to_string()
}

fn clean_phrase(text: &str) -> String {
    text.split_whitespace()
        .map(normalize_token)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn phrase_candidates(raw: &str) -> Vec<String> {
    let cleaned = clean_phrase(raw);
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    out.push(cleaned.clone());
    if words.len() > 10 {
        out.push(words[words.len().saturating_sub(10)..].join(" "));
    }
    if words.len() > 7 {
        out.push(words[words.len().saturating_sub(7)..].join(" "));
    }
    if words.len() > 4 {
        out.push(words[words.len().saturating_sub(4)..].join(" "));
    }
    out.sort();
    out.dedup();
    out
}

fn cut_before_instruction(tail: &str) -> &str {
    let markers = [
        " let us ",
        " let's ",
        " lets ",
        " put ",
        " play ",
        " add ",
        " show ",
        " display ",
        " use ",
        " as an overlay",
        " not as an overlay",
        " full screen",
        " fullscreen",
        ".",
        "\n",
    ];
    let mut end = tail.len();
    for marker in markers {
        if let Some(idx) = tail.find(marker) {
            end = end.min(idx);
        }
    }
    &tail[..end]
}

fn quoted_phrases_in_text(text: &str) -> Vec<String> {
    let mut phrases = Vec::new();
    let mut start: Option<(usize, char)> = None;
    for (idx, ch) in text.char_indices() {
        if matches!(ch, '"' | '\u{201c}' | '\u{201d}') {
            if let Some((open, open_ch)) = start.take() {
                if idx > open + open_ch.len_utf8() {
                    phrases.push(text[open + open_ch.len_utf8()..idx].to_string());
                }
            } else {
                start = Some((idx, ch));
            }
        }
    }
    phrases
}

fn extract_trigger_phrases_for_asset(ctx: &str, asset_name: &str) -> Vec<String> {
    let stem = asset_stem(asset_name);
    let Some(asset_idx) = ctx.find(asset_name).or_else(|| ctx.find(&stem)) else {
        return Vec::new();
    };

    let mut phrases = Vec::new();
    let window_start = floor_char_boundary(ctx, asset_idx.saturating_sub(750));
    let before = &ctx[window_start..asset_idx];
    for quoted in quoted_phrases_in_text(before).into_iter().rev().take(2) {
        phrases.extend(phrase_candidates(&quoted));
    }

    let marker_phrases = |text: &str, from_end: bool| -> Vec<String> {
        let markers = [
            "when ",
            "whenever ",
            "each time ",
            "every time ",
            "after ",
            "once ",
            "as soon as ",
        ];
        let found = if from_end {
            markers
                .iter()
                .filter_map(|marker| text.rfind(marker).map(|idx| (idx, *marker)))
                .max_by_key(|(idx, _)| *idx)
        } else {
            markers
                .iter()
                .filter_map(|marker| text.find(marker).map(|idx| (idx, *marker)))
                .min_by_key(|(idx, _)| *idx)
        };
        let Some((idx, marker)) = found else {
            return Vec::new();
        };
        let tail = &text[idx + marker.len()..];
        if let Some(quoted) = quoted_phrases_in_text(tail).into_iter().next() {
            return phrase_candidates(&quoted);
        }
        let speech_idx = [
            " says ",
            " say ",
            " said ",
            " hears ",
            " hear ",
            " mentions ",
            " mention ",
            " uses the phrase ",
        ]
        .iter()
        .filter_map(|verb| tail.find(verb).map(|i| i + verb.len()))
        .min();
        let phrase = speech_idx
            .map(|i| cut_before_instruction(&tail[i..]))
            .unwrap_or_else(|| cut_before_instruction(tail));
        phrase_candidates(phrase)
    };

    phrases.extend(marker_phrases(before, true));

    let clause = context_clause_for_asset(ctx, asset_name);
    if let Some(clause_idx) = clause.find(asset_name).or_else(|| clause.find(&stem)) {
        let after_start = ceil_char_boundary(&clause, clause_idx + asset_name.len());
        let after = &clause[after_start..];
        phrases.extend(marker_phrases(after, false));
    }

    phrases.sort_by_key(|p| std::cmp::Reverse(p.split_whitespace().count()));
    phrases.dedup();
    phrases
}

fn extract_until_phrases(window: &str) -> Vec<String> {
    let Some(until_idx) = window.find("until") else {
        return Vec::new();
    };
    let tail = &window[until_idx + "until".len()..];
    if let Some(quoted) = quoted_phrases_in_text(tail).into_iter().next() {
        return phrase_candidates(&quoted);
    }
    let tail = [
        "says ",
        "say ",
        "said ",
        "hears ",
        "hear ",
        "mentions ",
        "mention ",
        "phrase ",
    ]
    .iter()
    .filter_map(|marker| tail.find(marker).map(|idx| &tail[idx + marker.len()..]))
    .next()
    .unwrap_or(tail);
    let end = [".", ",", " after ", " then ", "\n"]
        .iter()
        .filter_map(|marker| tail.find(marker))
        .min()
        .unwrap_or(tail.len());
    phrase_candidates(&tail[..end])
}

fn extract_trigger_word_for_asset(ctx: &str, asset_name: &str) -> Option<String> {
    let stem = asset_stem(asset_name);
    let asset_idx = ctx.find(asset_name).or_else(|| ctx.find(&stem))?;
    let start = floor_char_boundary(ctx, asset_idx.saturating_sub(650));
    let before = &ctx[start..asset_idx];
    for marker in [
        "when ",
        "whenever ",
        "each time ",
        "every time ",
        "after ",
        "once ",
        "as soon as ",
    ] {
        if let Some(idx) = before.rfind(marker) {
            let tail = &before[idx + marker.len()..];
            let speech_idx = [" says ", " say ", " hear ", " hears ", " mentions ", " mention "]
                .iter()
                .filter_map(|verb| tail.find(verb).map(|i| i + verb.len()))
                .min();
            let Some(i) = speech_idx else {
                continue;
            };
            let phrase = cut_before_instruction(&tail[i..]);
            let mut words = phrase.split_whitespace().map(normalize_token).filter(|w| !w.is_empty());
            let first = words.next()?;
            if words.next().is_none() && stem.contains(&first) {
                return Some(first);
            }
        }
    }
    None
}

fn infer_asset_rules(show_context: &str, asset_files: &[TimelineAssetFile]) -> Vec<AssetRule> {
    asset_files
        .iter()
        .map(|asset| infer_rules_for_asset(asset, show_context))
        .collect()
}

fn matching_occurrences(words: &[crate::types::TranscriptWord], phrase: &str) -> Vec<WordOccurrence> {
    let token_count = phrase.split_whitespace().map(normalize_token).filter(|w| !w.is_empty()).count();
    let mut hits = if token_count <= 1 {
        find_word_occurrences(words, phrase)
    } else {
        find_phrase_occurrences(words, phrase)
    };
    hits.extend(find_fuzzy_phrase_occurrences(words, phrase));
    hits.sort_by_key(|h| h.start_ms);
    hits.dedup_by(|a, b| a.start_ms.abs_diff(b.start_ms) <= 900);
    hits
}

fn asset_duration_ms(asset_path: &Path, asset_kind: &str) -> u64 {
    if asset_kind == "image" {
        return DEFAULT_IMAGE_ASSET_DURATION_MS;
    }
    probe_video_duration_sec(asset_path.to_string_lossy().as_ref())
        .map(|s| (s * 1000.0).round().max(1.0) as u64)
        .unwrap_or(DEFAULT_TRIGGER_DURATION_MS)
}

fn trigger_duration_ms(
    rule: &AssetRule,
    trigger_start_ms: u64,
    asset_duration_ms: u64,
    words: &[crate::types::TranscriptWord],
) -> u64 {
    if rule.trigger_behavior == TriggerBehavior::Stateful {
        let end = rule
            .end_trigger_phrases
            .iter()
            .flat_map(|phrase| matching_occurrences(words, phrase))
            .filter(|hit| hit.end_ms > trigger_start_ms)
            .min_by_key(|hit| hit.start_ms);
        if let Some(end_hit) = end {
            return end_hit
                .end_ms
                .saturating_sub(trigger_start_ms)
                .clamp(1_000, MAX_OVERLAY_TRIGGER_DURATION_MS);
        }
    }

    rule.duration_ms.unwrap_or_else(|| {
        if rule.render_mode == "insert" {
            asset_duration_ms
        } else if rule.asset_kind == "image" {
            DEFAULT_IMAGE_ASSET_DURATION_MS
        } else {
            DEFAULT_TRIGGER_DURATION_MS
        }
    })
}

fn append_trigger_proposals(
    proposed: &mut Vec<ProposedAssetTrigger>,
    rule: &AssetRule,
    trigger: &str,
    hits: Vec<WordOccurrence>,
    words: &[crate::types::TranscriptWord],
    asset_duration_ms: u64,
    video_duration_ms: u64,
) {
    if hits.is_empty() {
        return;
    }

    let hits = if rule.prefer_late {
        let cutoff = video_duration_ms.saturating_mul(60) / 100;
        let late: Vec<_> = hits
            .iter()
            .filter(|h| h.start_ms >= cutoff)
            .cloned()
            .collect();
        if late.is_empty() {
            hits.into_iter().rev().take(1).collect()
        } else {
            late
        }
    } else {
        hits
    };

    for hit in hits {
        let start_ms = if rule.start_at_match_end {
            hit.end_ms
        } else {
            hit.start_ms
        };
        proposed.push(ProposedAssetTrigger {
            asset_file_name: rule.file_name.clone(),
            asset_kind: rule.asset_kind.clone(),
            trigger_word: Some(trigger.to_string()),
            placement_kind: rule.placement_kind.clone(),
            timeline_mode: rule.timeline_mode.clone(),
            render_mode: rule.render_mode.clone(),
            start_ms,
            duration_ms: trigger_duration_ms(rule, start_ms, asset_duration_ms, words),
            transcript_excerpt: hit.excerpt,
            full_screen: rule.full_screen,
        });
    }
}

pub fn propose_asset_triggers(
    transcript: &Transcript,
    show_context: &str,
    asset_folder: Option<&Path>,
    video_duration_ms: u64,
    provisional_content_end_ms: u64,
) -> Vec<ProposedAssetTrigger> {
    let Some(folder) = asset_folder.filter(|p| p.is_dir()) else {
        return Vec::new();
    };

    let asset_files = list_timeline_assets(folder);
    if asset_files.is_empty() {
        return Vec::new();
    }

    let rules = infer_asset_rules(show_context, &asset_files);
    let words = words_for_matching(transcript);
    let mut proposed = Vec::new();

    for rule in rules {
        let asset_path = folder.join(&rule.file_name);
        let asset_duration_ms = asset_duration_ms(&asset_path, &rule.asset_kind);

        match rule.schedule_anchor {
            ScheduleAnchor::Start => {
                proposed.push(ProposedAssetTrigger {
                    asset_file_name: rule.file_name.clone(),
                    asset_kind: rule.asset_kind.clone(),
                    trigger_word: None,
                    placement_kind: rule.placement_kind.clone(),
                    timeline_mode: rule.timeline_mode.clone(),
                    render_mode: rule.render_mode.clone(),
                    start_ms: 0,
                    duration_ms: rule.duration_ms.unwrap_or(asset_duration_ms),
                    transcript_excerpt: "Scheduled asset at the beginning of the timeline.".to_string(),
                    full_screen: rule.full_screen || rule.render_mode == "insert",
                });
            }
            ScheduleAnchor::End => {
                let duration = rule.duration_ms.unwrap_or(asset_duration_ms);
                let start = provisional_content_end_ms.min(video_duration_ms);
                proposed.push(ProposedAssetTrigger {
                    asset_file_name: rule.file_name.clone(),
                    asset_kind: rule.asset_kind.clone(),
                    trigger_word: None,
                    placement_kind: rule.placement_kind.clone(),
                    timeline_mode: rule.timeline_mode.clone(),
                    render_mode: rule.render_mode.clone(),
                    start_ms: start,
                    duration_ms: duration,
                    transcript_excerpt: "Scheduled asset near the end of the timeline.".to_string(),
                    full_screen: rule.full_screen || rule.render_mode == "insert",
                });
            }
            ScheduleAnchor::None => {
                if rule.trigger_words.is_empty() && rule.trigger_phrases.is_empty() {
                    continue;
                }
                for phrase in &rule.trigger_phrases {
                    let hits = matching_occurrences(&words, phrase);
                    append_trigger_proposals(
                        &mut proposed,
                        &rule,
                        phrase,
                        hits,
                        &words,
                        asset_duration_ms,
                        video_duration_ms,
                    );
                }
                for trigger in &rule.trigger_words {
                    let hits = matching_occurrences(&words, trigger);
                    append_trigger_proposals(
                        &mut proposed,
                        &rule,
                        trigger,
                        hits,
                        &words,
                        asset_duration_ms,
                        video_duration_ms,
                    );
                }
            }
        }
    }

    proposed
}

fn placement_track_index(timeline_mode: &str, render_mode: &str) -> u32 {
    if timeline_mode == "insert" || render_mode == "insert" {
        2
    } else {
        1
    }
}

pub fn asset_placements_from_proposals(proposed: &[ProposedAssetTrigger]) -> Vec<AssetPlacement> {
    let mut placements: Vec<AssetPlacement> = proposed
        .iter()
        .map(|p| AssetPlacement {
            id: uuid::Uuid::new_v4().to_string(),
            asset_file_name: p.asset_file_name.clone(),
            asset_kind: p.asset_kind.clone(),
            trigger_word: p.trigger_word.clone(),
            placement_kind: p.placement_kind.clone(),
            timeline_mode: p.timeline_mode.clone(),
            render_mode: p.render_mode.clone(),
            start_ms: p.start_ms,
            duration_ms: p.duration_ms,
            transcript_excerpt: Some(p.transcript_excerpt.clone()),
            verified: true,
            rationale: "Matched from the current master prompt and transcript timing.".to_string(),
            track_index: placement_track_index(&p.timeline_mode, &p.render_mode),
            full_screen: p.full_screen,
        })
        .collect();

    placements.sort_by(|a, b| {
        (
            a.start_ms,
            a.asset_file_name.to_lowercase(),
            a.placement_kind.clone(),
        )
            .cmp(&(
                b.start_ms,
                b.asset_file_name.to_lowercase(),
                b.placement_kind.clone(),
            ))
    });
    placements.dedup_by(|a, b| {
        a.asset_file_name.eq_ignore_ascii_case(&b.asset_file_name)
            && a.placement_kind == b.placement_kind
            && a.timeline_mode == b.timeline_mode
            && a.render_mode == b.render_mode
            && a.start_ms.abs_diff(b.start_ms) <= 500
    });
    placements
}

pub fn propose_asset_placements_from_settings(
    transcript: &Transcript,
    settings: &ProjectSettings,
    content_end_hint_ms: Option<u64>,
) -> Vec<AssetPlacement> {
    let video_duration_ms = probe_video_duration_sec(&transcript.video_path)
        .map(|s| (s * 1000.0).round().max(1.0) as u64)
        .unwrap_or_else(|_| transcript.segments.last().map(|s| s.end_ms).unwrap_or(0));
    let provisional_end = content_end_hint_ms
        .unwrap_or_else(|| provisional_content_end_ms(transcript, video_duration_ms))
        .min(video_duration_ms);
    let asset_folder = settings
        .asset_folder_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(Path::new);
    let proposed = propose_asset_triggers(
        transcript,
        &settings.show_context,
        asset_folder,
        video_duration_ms,
        provisional_end,
    );
    asset_placements_from_proposals(&proposed)
}

pub fn provisional_content_end_ms(transcript: &Transcript, video_duration_ms: u64) -> u64 {
    transcript
        .segments
        .last()
        .map(|s| s.end_ms)
        .unwrap_or(video_duration_ms)
        .min(video_duration_ms)
}

pub fn resolve_asset_absolute(asset_folder: &Path, file_name: &str) -> Result<PathBuf, String> {
    let path = asset_folder.join(file_name);
    if !path.is_file() {
        return Err(format!("asset_not_found:{file_name}"));
    }
    Ok(path)
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
    fn prompt_semantics_create_scheduled_and_stateful_asset_rules() {
        let dir = std::env::temp_dir().join(format!(
            "devotiontime-assets-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("opener.mp4"), b"not a real video").unwrap();
        std::fs::write(dir.join("badge.png"), b"not a real image").unwrap();

        let transcript = Transcript {
            video_id: "v1".to_string(),
            video_path: "episode.mp4".to_string(),
            full_text: "Today is launch day and now we are done.".to_string(),
            segments: vec![TranscriptSegment {
                start_ms: 0,
                end_ms: 4_000,
                text: "Today is launch day and now we are done.".to_string(),
            }],
            words: Some(vec![
                word(0, "Today"),
                word(500, "is"),
                word(1_000, "launch"),
                word(1_500, "day"),
                word(2_000, "and"),
                word(2_500, "now"),
                word(3_000, "we"),
                word(3_500, "are"),
                word(4_000, "done"),
            ]),
            probed_video_stream_start_sec: None,
            probed_audio_stream_start_sec: None,
            applied_transcript_timing_offset_ms: None,
        };
        let prompt = "Start every video with opener.mp4. Each time the speaker says launch day, show badge.png as an overlay until the speaker says done.";

        let proposed = propose_asset_triggers(&transcript, prompt, Some(&dir), 5_000, 4_000);
        std::fs::remove_dir_all(&dir).ok();

        let opener = proposed
            .iter()
            .find(|p| p.asset_file_name == "opener.mp4")
            .expect("opener placement");
        assert_eq!(opener.placement_kind, "scheduled_start");
        assert_eq!(opener.render_mode, "insert");

        let badge = proposed
            .iter()
            .find(|p| p.asset_file_name == "badge.png")
            .expect("badge placement");
        assert_eq!(badge.asset_kind, "image");
        assert_eq!(badge.render_mode, "overlay");
        assert!(badge.duration_ms >= 1_500);
    }

    #[test]
    fn intro_and_outro_filenames_schedule_as_inserts() {
        let dir = std::env::temp_dir().join(format!(
            "devotiontime-assets-intro-outro-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Intro.mp4"), b"not a real video").unwrap();
        std::fs::write(dir.join("Outro.mp4"), b"not a real video").unwrap();

        let transcript = Transcript {
            video_id: "v1".to_string(),
            video_path: "episode.mp4".to_string(),
            full_text: "Episode content.".to_string(),
            segments: vec![TranscriptSegment {
                start_ms: 0,
                end_ms: 4_000,
                text: "Episode content.".to_string(),
            }],
            words: None,
            probed_video_stream_start_sec: None,
            probed_audio_stream_start_sec: None,
            applied_transcript_timing_offset_ms: None,
        };
        let prompt = "Use the assets in the folder. When the speaker says introduction, play cheer.mp4.";

        let proposed = propose_asset_triggers(&transcript, prompt, Some(&dir), 60_000, 55_000);
        std::fs::remove_dir_all(&dir).ok();

        let intro = proposed
            .iter()
            .find(|p| p.asset_file_name.eq_ignore_ascii_case("Intro.mp4"))
            .expect("intro placement");
        assert_eq!(intro.placement_kind, "scheduled_start");
        assert_eq!(intro.render_mode, "insert");
        assert_eq!(intro.start_ms, 0);

        let outro = proposed
            .iter()
            .find(|p| p.asset_file_name.eq_ignore_ascii_case("Outro.mp4"))
            .expect("outro placement");
        assert_eq!(outro.placement_kind, "scheduled_end");
        assert_eq!(outro.render_mode, "insert");
    }
}
