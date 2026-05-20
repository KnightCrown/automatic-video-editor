use std::fs::File;
use std::path::Path;
use std::time::UNIX_EPOCH;

use chrono::Utc;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::store::project::{
    load_audio_waveform, load_project, project_paths, save_audio_waveform,
    transcription_audio_path,
};
use crate::types::AudioWaveform;

const PEAKS_PER_SECOND: usize = 30;
const MAX_STORED_PEAKS: usize = 12_000;

fn source_modified_ms(path: &str) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn cached_waveform_is_fresh(waveform: &AudioWaveform, source_path: &str) -> bool {
    waveform.source_path == source_path
        && waveform.source_modified_ms == source_modified_ms(source_path)
}

fn waveform_newer_than_wav(
    paths: &crate::store::project::ProjectPaths,
    video_id: &str,
    waveform: &AudioWaveform,
) -> bool {
    let Ok(wav_path) = transcription_audio_path(paths, video_id) else {
        return false;
    };
    if !wav_path.is_file() {
        return false;
    }
    let Ok(wav_modified) = wav_path.metadata().and_then(|m| m.modified()) else {
        return false;
    };
    let Ok(waveform_ts) = chrono::DateTime::parse_from_rfc3339(&waveform.generated_at)
        .map(|dt| dt.timestamp())
    else {
        return true;
    };
    let wav_secs = wav_modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    wav_secs > waveform_ts
}

fn downsample_peaks(peaks: Vec<f32>, bucket_duration_ms: f64) -> (Vec<f32>, f64) {
    if peaks.len() <= MAX_STORED_PEAKS {
        return (peaks, bucket_duration_ms);
    }

    let factor = peaks.len().div_ceil(MAX_STORED_PEAKS);
    let compacted = peaks
        .chunks(factor)
        .map(|chunk| chunk.iter().copied().fold(0.0_f32, f32::max))
        .collect();
    (compacted, bucket_duration_ms * factor as f64)
}

fn normalize_peaks(mut peaks: Vec<f32>) -> Vec<f32> {
    let max_peak = peaks.iter().copied().fold(0.0_f32, f32::max);
    if max_peak > 0.0001 {
        for peak in &mut peaks {
            *peak = (*peak / max_peak).clamp(0.0, 1.0);
        }
    }
    peaks
}

pub fn generate_audio_waveform_from_file(
    video_id: &str,
    video_path: &str,
    audio_path: &str,
) -> Result<AudioWaveform, String> {
    let source = Box::new(
        File::open(audio_path).map_err(|e| format!("open_waveform_source:{e}"))?,
    );
    let mss = MediaSourceStream::new(source, Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(audio_path)
        .extension()
        .and_then(|ext| ext.to_str())
    {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe_audio_waveform:{e}"))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|track| {
            track.codec_params.codec != CODEC_TYPE_NULL
                && track.codec_params.sample_rate.is_some()
                && track.codec_params.channels.is_some()
        })
        .ok_or_else(|| "audio_track_not_found".to_string())?;
    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| "audio_sample_rate_not_found".to_string())?;
    let bucket_frames = ((sample_rate as usize) / PEAKS_PER_SECOND).max(1);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("create_waveform_decoder:{e}"))?;

    let mut peaks: Vec<f32> = Vec::new();
    let mut total_frames: u64 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err("waveform_decode_reset_required".to_string());
            }
            Err(err) => return Err(format!("read_waveform_packet:{err}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(_)) => break,
            Err(err) => return Err(format!("decode_waveform_packet:{err}")),
        };

        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buffer.copy_interleaved_ref(decoded);
        let samples = sample_buffer.samples();

        for frame in samples.chunks(channels) {
            let amp = frame
                .iter()
                .map(|sample| sample.abs())
                .filter(|sample| sample.is_finite())
                .fold(0.0_f32, f32::max)
                .clamp(0.0, 1.0);
            let bucket_idx = (total_frames as usize) / bucket_frames;
            if bucket_idx >= peaks.len() {
                peaks.resize(bucket_idx + 1, 0.0);
            }
            if amp > peaks[bucket_idx] {
                peaks[bucket_idx] = amp;
            }
            total_frames += 1;
        }
    }

    if peaks.is_empty() {
        return Err("audio_waveform_empty".to_string());
    }

    let bucket_duration_ms = (bucket_frames as f64 / sample_rate as f64) * 1000.0;
    let duration_ms = ((total_frames as f64 / sample_rate as f64) * 1000.0).round() as u64;
    let (peaks, bucket_duration_ms) = downsample_peaks(normalize_peaks(peaks), bucket_duration_ms);

    Ok(AudioWaveform {
        video_id: video_id.to_string(),
        generated_at: Utc::now().to_rfc3339(),
        source_path: video_path.to_string(),
        source_modified_ms: source_modified_ms(video_path),
        duration_ms,
        bucket_duration_ms,
        peaks,
    })
}

/// Build peak data from the saved transcription WAV and persist it for the timeline UI.
pub fn generate_and_save_waveform_from_transcription_wav(
    root_path: &str,
    video_id: &str,
    video_path: &str,
    wav_path: &str,
) -> Result<AudioWaveform, String> {
    let paths = project_paths(root_path)?;
    let waveform = generate_audio_waveform_from_file(video_id, video_path, wav_path)?;
    save_audio_waveform(&paths, &waveform)?;
    Ok(waveform)
}

pub fn ensure_audio_waveform_for_video(
    root_path: &str,
    video_id: &str,
) -> Result<AudioWaveform, String> {
    let paths = project_paths(root_path)?;
    let project = load_project(root_path)?;
    let video = project
        .videos
        .iter()
        .find(|video| video.id == video_id)
        .ok_or_else(|| "video_not_found".to_string())?;

    if let Ok(Some(waveform)) = load_audio_waveform(&paths, video_id) {
        if cached_waveform_is_fresh(&waveform, &video.path)
            && !waveform_newer_than_wav(&paths, video_id, &waveform)
        {
            return Ok(waveform);
        }
    }

    let wav_path = transcription_audio_path(&paths, video_id)?;
    if wav_path.is_file() {
        let waveform = generate_audio_waveform_from_file(
            video_id,
            &video.path,
            &wav_path.to_string_lossy(),
        )?;
        save_audio_waveform(&paths, &waveform)?;
        return Ok(waveform);
    }

    let waveform = generate_audio_waveform_from_file(video_id, &video.path, &video.path)?;
    save_audio_waveform(&paths, &waveform)?;
    Ok(waveform)
}
