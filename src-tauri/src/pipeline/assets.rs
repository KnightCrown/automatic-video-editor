use std::path::{Path, PathBuf};

use crate::pipeline::word_timing::{
    find_phrase_occurrences, find_word_occurrences, normalize_token, words_for_matching,
};
use crate::types::{AssetPlacement, ProjectSettings, ProposedAssetTrigger, Transcript};
use crate::video::encoders::probe_video_duration_sec;
use crate::video::extensions::is_video_file_extension;

const DEFAULT_TRIGGER_DURATION_MS: u64 = 2_000;
const MAX_OVERLAY_TRIGGER_DURATION_MS: u64 = 180_000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum AssetPlacementKind {
    Intro,
    Outro,
    Trigger,
}

#[derive(Debug, Clone)]
struct AssetRule {
    file_name: String,
    kind: AssetPlacementKind,
    trigger_words: Vec<String>,
    trigger_phrases: Vec<String>,
    end_trigger_phrases: Vec<String>,
    duration_ms: Option<u64>,
    full_screen: bool,
    timeline_mode: String,
    prefer_late: bool,
    start_at_match_end: bool,
}

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

fn infer_rules_for_file(file_name: &str, show_context: &str) -> AssetRule {
    let lower_name = file_name.to_lowercase();
    let ctx = show_context.to_lowercase();
    let mut trigger_words = Vec::new();
    let mut trigger_phrases = Vec::new();
    let mut end_trigger_phrases = Vec::new();
    let mut kind = AssetPlacementKind::Trigger;
    let asset_window = context_window_for_asset(&ctx, &lower_name);
    let stem = asset_stem(&lower_name);
    let mut full_screen = lower_name.contains("surprise")
        || asset_window.contains("full-screen")
        || asset_window.contains("full screen")
        || asset_window.contains("not as an overlay");
    let mut timeline_mode = "overlay".to_string();
    let mut prefer_late = false;
    let mut start_at_match_end = false;

    if lower_name.contains("intro")
        || asset_window.contains(" at the start ")
        || asset_window.contains("start of the show")
        || ctx.contains(&format!("start every video with {lower_name}"))
        || ctx.contains(&format!("start with {lower_name}"))
    {
        kind = AssetPlacementKind::Intro;
    } else if lower_name.contains("outro")
        || ctx.contains(&format!("add {lower_name} at the end"))
        || ctx.contains(&format!("then add {lower_name}"))
        || asset_window.contains(" at the end")
        || asset_window.contains("after the episode")
    {
        kind = AssetPlacementKind::Outro;
    }

    if kind == AssetPlacementKind::Intro || kind == AssetPlacementKind::Outro {
        timeline_mode = "insert".to_string();
        full_screen = true;
    } else {
        let overlay_requested = asset_window.contains("as an overlay")
            || asset_window.contains("regular overlay")
            || asset_window.contains("overlay position")
            || asset_window.contains("on screen until");
        let insert_requested = asset_window.contains("not as an overlay")
            || asset_window.contains("episode continues")
            || asset_window.contains("continue the episode")
            || asset_window.contains("then the episode continues")
            || asset_window.contains("full-screen")
            || asset_window.contains("full screen");
        if insert_requested && !overlay_requested {
            timeline_mode = "insert".to_string();
            full_screen = true;
            start_at_match_end = true;
        }
        prefer_late = asset_window.contains("towards the end")
            || asset_window.contains("near the end")
            || asset_window.contains("final prayer")
            || asset_window.contains("end of the episode");

        trigger_phrases.extend(extract_trigger_phrases_for_asset(&ctx, &lower_name));
        end_trigger_phrases.extend(extract_until_phrases(&asset_window));
        if let Some(word) = extract_trigger_word_for_asset(&ctx, &lower_name) {
            trigger_words.push(word);
        }
        if trigger_words.is_empty() {
            if stem.len() >= 2 && ctx.contains(&format!("says {stem}")) {
                trigger_words.push(stem.clone());
            }
        }
    }

    AssetRule {
        file_name: file_name.to_string(),
        kind,
        trigger_words,
        trigger_phrases,
        end_trigger_phrases,
        duration_ms: None,
        full_screen,
        timeline_mode,
        prefer_late,
        start_at_match_end,
    }
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
    let start = floor_char_boundary(ctx, idx.saturating_sub(900));
    let end = ceil_char_boundary(ctx, (idx + asset_name.len() + 900).min(ctx.len()));
    ctx[start..end].to_string()
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
    if words.len() > 8 {
        out.push(words[words.len().saturating_sub(8)..].join(" "));
    }
    if words.len() > 5 {
        out.push(words[words.len().saturating_sub(5)..].join(" "));
    }
    out.sort();
    out.dedup();
    out
}

fn cut_before_instruction(tail: &str) -> &str {
    let markers = [
        " let's put ",
        " let us put ",
        " lets put ",
        " put ",
        " play ",
        " add ",
        " show ",
        " display ",
        " on the screen",
        " as an overlay",
        ".",
    ];
    let mut end = tail.len();
    for marker in markers {
        if let Some(idx) = tail.find(marker) {
            end = end.min(idx);
        }
    }
    &tail[..end]
}

fn quoted_phrases_before_asset(ctx: &str, asset_idx: usize) -> Vec<String> {
    let before = &ctx[..asset_idx];
    let mut phrases = Vec::new();
    let mut start: Option<(usize, char)> = None;
    for (idx, ch) in before.char_indices() {
        if ch == '"' || ch == '\u{201c}' || ch == '\u{201d}' {
            if let Some((open, open_ch)) = start.take() {
                if idx > open + open_ch.len_utf8() {
                    phrases.push(before[open + open_ch.len_utf8()..idx].to_string());
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
    for quoted in quoted_phrases_before_asset(ctx, asset_idx)
        .into_iter()
        .rev()
        .take(2)
    {
        phrases.extend(phrase_candidates(&quoted));
    }

    let before_start = floor_char_boundary(ctx, asset_idx.saturating_sub(650));
    let before = &ctx[before_start..asset_idx];
    for marker in [
        "when the user says ",
        "when they say ",
        "when the host says ",
        "each time the user says ",
        "each time they say ",
        "after she says ",
        "after they say ",
        "after the host says ",
        "says ",
    ] {
        if let Some(idx) = before.rfind(marker) {
            let tail = &before[idx + marker.len()..];
            let phrase = cut_before_instruction(tail);
            phrases.extend(phrase_candidates(phrase));
            break;
        }
    }

    phrases.retain(|p| p.split_whitespace().count() >= 2);
    phrases.sort_by_key(|p| std::cmp::Reverse(p.split_whitespace().count()));
    phrases.dedup();
    phrases
}

fn extract_until_phrases(window: &str) -> Vec<String> {
    let Some(until_idx) = window.find("until") else {
        return Vec::new();
    };
    let tail = &window[until_idx + "until".len()..];
    let tail = if let Some(says_idx) = tail.find("says ") {
        &tail[says_idx + "says ".len()..]
    } else {
        tail
    };
    let end = [".", ",", " after ", " then "]
        .iter()
        .filter_map(|marker| tail.find(marker))
        .min()
        .unwrap_or(tail.len());
    phrase_candidates(&tail[..end])
}

fn extract_trigger_word_for_asset(ctx: &str, asset_name: &str) -> Option<String> {
    let stem = Path::new(asset_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(asset_name);

    for pattern in [
        format!("says {stem}"),
        format!("say {stem}"),
        format!("when the host says {stem}"),
        format!("when they say {stem}"),
        format!("each time the host says {stem}"),
        format!("each time they say {stem}"),
    ] {
        if ctx.contains(&pattern) {
            return Some(stem.to_string());
        }
    }

    if let Some(idx) = ctx.find("says ") {
        let tail = &ctx[idx + 5..];
        if let Some(word) = tail.split_whitespace().next() {
            let cleaned = normalize_token(word);
            if !cleaned.is_empty() && asset_name.contains(&cleaned) {
                return Some(cleaned);
            }
        }
    }
    None
}

fn infer_asset_rules(show_context: &str, asset_files: &[String]) -> Vec<AssetRule> {
    asset_files
        .iter()
        .map(|f| infer_rules_for_file(f, show_context))
        .collect()
}

fn placement_kind_label(kind: &AssetPlacementKind) -> &'static str {
    match kind {
        AssetPlacementKind::Intro => "intro",
        AssetPlacementKind::Outro => "outro",
        AssetPlacementKind::Trigger => "trigger",
    }
}

fn trigger_duration_ms(
    rule: &AssetRule,
    trigger_start_ms: u64,
    asset_duration_ms: u64,
    words: &[crate::types::TranscriptWord],
) -> u64 {
    if !rule.end_trigger_phrases.is_empty() {
        let end = rule
            .end_trigger_phrases
            .iter()
            .flat_map(|phrase| find_phrase_occurrences(words, phrase))
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
        if rule.timeline_mode == "insert" {
            asset_duration_ms
        } else {
            DEFAULT_TRIGGER_DURATION_MS
        }
    })
}

fn append_trigger_proposals(
    proposed: &mut Vec<ProposedAssetTrigger>,
    rule: &AssetRule,
    trigger: &str,
    hits: Vec<crate::pipeline::word_timing::WordOccurrence>,
    words: &[crate::types::TranscriptWord],
    asset_duration_ms: u64,
    video_duration_ms: u64,
) {
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
            trigger_word: Some(trigger.to_string()),
            placement_kind: placement_kind_label(&rule.kind).to_string(),
            timeline_mode: rule.timeline_mode.clone(),
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

    let asset_files = list_video_assets(folder);
    if asset_files.is_empty() {
        return Vec::new();
    }

    let rules = infer_asset_rules(show_context, &asset_files);
    let words = words_for_matching(transcript);
    let mut proposed = Vec::new();

    for rule in rules {
        let asset_path = folder.join(&rule.file_name);
        let asset_duration_ms = probe_video_duration_sec(asset_path.to_string_lossy().as_ref())
            .map(|s| (s * 1000.0).round().max(1.0) as u64)
            .unwrap_or(DEFAULT_TRIGGER_DURATION_MS);

        match rule.kind {
            AssetPlacementKind::Intro => {
                proposed.push(ProposedAssetTrigger {
                    asset_file_name: rule.file_name.clone(),
                    trigger_word: None,
                    placement_kind: "intro".to_string(),
                    timeline_mode: "insert".to_string(),
                    start_ms: 0,
                    duration_ms: rule.duration_ms.unwrap_or(asset_duration_ms),
                    transcript_excerpt: "Intro asset at timeline start.".to_string(),
                    full_screen: true,
                });
            }
            AssetPlacementKind::Outro => {
                let duration = rule.duration_ms.unwrap_or(asset_duration_ms);
                let start = provisional_content_end_ms.min(video_duration_ms);
                proposed.push(ProposedAssetTrigger {
                    asset_file_name: rule.file_name.clone(),
                    trigger_word: None,
                    placement_kind: "outro".to_string(),
                    timeline_mode: "insert".to_string(),
                    start_ms: start,
                    duration_ms: duration,
                    transcript_excerpt: "Outro asset after episode content.".to_string(),
                    full_screen: true,
                });
            }
            AssetPlacementKind::Trigger => {
                if rule.trigger_words.is_empty() && rule.trigger_phrases.is_empty() {
                    continue;
                }
                for phrase in &rule.trigger_phrases {
                    let hits = find_phrase_occurrences(&words, phrase);
                    if hits.is_empty() {
                        continue;
                    }
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
                    let hits = find_word_occurrences(&words, trigger);
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

pub fn asset_placements_from_proposals(proposed: &[ProposedAssetTrigger]) -> Vec<AssetPlacement> {
    let mut placements: Vec<AssetPlacement> = proposed
        .iter()
        .map(|p| AssetPlacement {
            id: uuid::Uuid::new_v4().to_string(),
            asset_file_name: p.asset_file_name.clone(),
            trigger_word: p.trigger_word.clone(),
            placement_kind: p.placement_kind.clone(),
            timeline_mode: p.timeline_mode.clone(),
            start_ms: p.start_ms,
            duration_ms: p.duration_ms,
            transcript_excerpt: Some(p.transcript_excerpt.clone()),
            verified: true,
            rationale: "Matched from the current master prompt and transcript timing.".to_string(),
            track_index: if p.timeline_mode == "insert"
                || p.placement_kind == "intro"
                || p.placement_kind == "outro"
            {
                2
            } else {
                1
            },
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
