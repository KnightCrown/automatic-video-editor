use std::sync::Mutex;

use once_cell::sync::Lazy;
use parakeet_rs::{ParakeetTDT, TimestampMode, Transcriber};
use tauri::{AppHandle, Emitter};

use crate::asr::model_download::{missing_parakeet_files, model_dir};
use crate::audio::ffmpeg::probe_av_stream_start_times;
use crate::pipeline::word_timing::build_interpolated_words;
use crate::types::{PipelineProgress, Transcript, TranscriptSegment};

const TRANSCRIBE_PROGRESS_START: f64 = 40.0;
const TRANSCRIBE_PROGRESS_END: f64 = 95.0;

static TRANSCRIBER: Lazy<Mutex<Option<ParakeetTDT>>> = Lazy::new(|| Mutex::new(None));

/// Parakeet TDT ONNX models fail on long clips (attention broadcast errors).
/// Keep chunks well under the documented ~8–10 minute limit.
const MAX_CHUNK_SECS: f64 = 240.0;

fn load_transcriber(app: &AppHandle) -> Result<(), String> {
    let mut guard = TRANSCRIBER
        .lock()
        .map_err(|_| "transcriber_lock_failed".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let dir = model_dir(app)?;
    if !dir.is_dir() {
        return Err(
            "Parakeet model is not downloaded. Open Settings and download the speech model first."
                .to_string(),
        );
    }
    let missing = missing_parakeet_files(app)?;
    if !missing.is_empty() {
        return Err(format!(
            "Parakeet model is incomplete. Missing files: {}. Re-download the model in Settings.",
            missing.join(", ")
        ));
    }
    let model = ParakeetTDT::from_pretrained(&dir, None).map_err(|e| {
        format!(
            "Failed to load Parakeet model from {}: {}. Try re-downloading the model in Settings.",
            dir.display(),
            e
        )
    })?;
    *guard = Some(model);
    Ok(())
}

fn read_wav_mono(path: &str) -> Result<(Vec<f32>, u32), String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("Failed to read WAV file: {e}"))?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels.max(1);

    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read WAV samples: {e}"))?,
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|s| s.map(|s| s as f32 / 32768.0))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read WAV samples: {e}"))?,
    };

    if channels == 1 {
        return Ok((raw, sample_rate));
    }

    let ch = channels as usize;
    let mono: Vec<f32> = raw
        .chunks(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect();
    Ok((mono, sample_rate))
}

fn chunk_audio(audio: &[f32], sample_rate: u32) -> Vec<(usize, Vec<f32>)> {
    let chunk_samples = ((sample_rate as f64) * MAX_CHUNK_SECS).ceil() as usize;
    if audio.is_empty() {
        return Vec::new();
    }
    if audio.len() <= chunk_samples {
        return vec![(0, audio.to_vec())];
    }

    let mut chunks = Vec::new();
    let mut offset = 0usize;
    while offset < audio.len() {
        let end = (offset + chunk_samples).min(audio.len());
        chunks.push((offset, audio[offset..end].to_vec()));
        if end >= audio.len() {
            break;
        }
        offset = end;
    }
    chunks
}

fn add_signed_ms(ms: u64, delta: i64) -> u64 {
    if delta >= 0 {
        ms.saturating_add(delta as u64)
    } else {
        ms.saturating_sub((-delta) as u64)
    }
}

fn apply_transcript_timing_offset(t: &mut Transcript, delta_ms: i64) {
    if delta_ms == 0 {
        return;
    }
    for s in &mut t.segments {
        s.start_ms = add_signed_ms(s.start_ms, delta_ms);
        s.end_ms = add_signed_ms(s.end_ms, delta_ms);
    }
    if let Some(ref mut words) = t.words {
        for w in words {
            w.start_ms = add_signed_ms(w.start_ms, delta_ms);
            w.end_ms = add_signed_ms(w.end_ms, delta_ms);
        }
    }
}

fn emit_transcribe_progress(
    app: &AppHandle,
    job_id: &str,
    percent: f64,
    message: &str,
    batch: Option<(u32, u32)>,
) {
    let (episode_index, episode_total) = match batch {
        Some((i, t)) => (Some(i), Some(t)),
        None => (None, None),
    };
    let _ = app.emit(
        "pipeline_progress",
        PipelineProgress {
            job_id: job_id.to_string(),
            stage: "transcribe".to_string(),
            percent: percent as f32,
            message: Some(message.to_string()),
            episode_index,
            episode_total,
        },
    );
}

fn transcribe_chunks(
    app: &AppHandle,
    job_id: &str,
    model: &mut ParakeetTDT,
    audio: Vec<f32>,
    sample_rate: u32,
    batch: Option<(u32, u32)>,
) -> Result<(String, Vec<TranscriptSegment>), String> {
    let chunks = chunk_audio(&audio, sample_rate);
    let chunk_count = chunks.len().max(1);

    let mut full_text_parts: Vec<String> = Vec::new();
    let mut all_segments: Vec<TranscriptSegment> = Vec::new();

    for (index, (sample_offset, chunk)) in chunks.into_iter().enumerate() {
        let chunk_num = index + 1;
        let percent = TRANSCRIBE_PROGRESS_START
            + (TRANSCRIBE_PROGRESS_END - TRANSCRIBE_PROGRESS_START)
                * (index as f64 / chunk_count as f64);
        emit_transcribe_progress(
            app,
            job_id,
            percent,
            &format!("Transcribing chunk {chunk_num} of {chunk_count}…"),
            batch,
        );

        let offset_secs = sample_offset as f64 / sample_rate as f64;

        let result = model
            .transcribe_samples(chunk, sample_rate, 1, Some(TimestampMode::Sentences))
            .map_err(|e| {
                let duration_mins = audio.len() as f64 / sample_rate as f64 / 60.0;
                format!(
                    "Parakeet failed on chunk {} of {} (~{:.0}s–{:.0}s of {:.1} min audio): {}. \
                     If this persists, try a shorter clip or report the issue.",
                    index + 1,
                    chunk_count,
                    offset_secs,
                    offset_secs + MAX_CHUNK_SECS,
                    duration_mins,
                    e
                )
            })?;

        let text = result.text.trim();
        if !text.is_empty() {
            full_text_parts.push(text.to_string());
        }

        let offset_secs = offset_secs as f32;
        for token in result.tokens {
            let text = token.text.trim();
            if text.is_empty() {
                continue;
            }
            all_segments.push(TranscriptSegment {
                start_ms: ((token.start + offset_secs) * 1000.0) as u64,
                end_ms: ((token.end + offset_secs) * 1000.0) as u64,
                text: token.text,
            });
        }
    }

    emit_transcribe_progress(
        app,
        job_id,
        TRANSCRIBE_PROGRESS_END,
        "Merging transcript…",
        batch,
    );

    Ok((full_text_parts.join(" "), all_segments))
}

pub fn transcribe_wav(
    app: &AppHandle,
    job_id: &str,
    wav_path: &str,
    video_id: &str,
    video_path: &str,
    transcript_timing_offset_ms: i64,
    batch: Option<(u32, u32)>,
) -> Result<Transcript, String> {
    load_transcriber(app)?;

    let (audio, sample_rate) = read_wav_mono(wav_path)?;
    let duration_secs = audio.len() as f64 / sample_rate as f64;

    let mut guard = TRANSCRIBER
        .lock()
        .map_err(|_| "transcriber_lock_failed".to_string())?;
    let model = guard
        .as_mut()
        .ok_or_else(|| "parakeet_not_loaded".to_string())?;

    let (full_text, segments) = if duration_secs > MAX_CHUNK_SECS {
        transcribe_chunks(app, job_id, model, audio, sample_rate, batch)?
    } else {
        emit_transcribe_progress(
            app,
            job_id,
            TRANSCRIBE_PROGRESS_START,
            "Transcribing with Parakeet…",
            batch,
        );
        let result = model
            .transcribe_samples(audio, sample_rate, 1, Some(TimestampMode::Sentences))
            .map_err(|e| {
                format!(
                    "Parakeet transcription failed ({:.1}s audio): {e}",
                    duration_secs
                )
            })?;

        let segments: Vec<TranscriptSegment> = result
            .tokens
            .iter()
            .map(|t| TranscriptSegment {
                start_ms: (t.start * 1000.0) as u64,
                end_ms: (t.end * 1000.0) as u64,
                text: t.text.clone(),
            })
            .collect();

        (result.text, segments)
    };

    let words = build_interpolated_words(&Transcript {
        video_id: video_id.to_string(),
        video_path: video_path.to_string(),
        full_text: full_text.clone(),
        segments: segments.clone(),
        words: None,
        probed_video_stream_start_sec: None,
        probed_audio_stream_start_sec: None,
        applied_transcript_timing_offset_ms: None,
    });

    let (probed_video, probed_audio) = probe_av_stream_start_times(video_path);

    let mut transcript = Transcript {
        video_id: video_id.to_string(),
        video_path: video_path.to_string(),
        full_text,
        segments,
        words: Some(words),
        probed_video_stream_start_sec: probed_video,
        probed_audio_stream_start_sec: probed_audio,
        applied_transcript_timing_offset_ms: None,
    };

    apply_transcript_timing_offset(&mut transcript, transcript_timing_offset_ms);
    if transcript_timing_offset_ms != 0 {
        transcript.applied_transcript_timing_offset_ms = Some(transcript_timing_offset_ms);
    }

    Ok(transcript)
}

pub fn invalidate_transcriber() {
    if let Ok(mut guard) = TRANSCRIBER.lock() {
        *guard = None;
    }
}
