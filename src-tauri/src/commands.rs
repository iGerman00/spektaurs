use crate::audio;
use crate::fft::WindowFunction;
use crate::pipeline::{run_pipeline, SpectrogramResult};
use crate::preferences::Preferences;
use crate::utils::vercmp;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[tauri::command]
pub fn get_preferences() -> serde_json::Value {
    Preferences::global().get_all()
}

#[tauri::command]
pub fn set_check_update(value: bool) -> bool {
    Preferences::global().set_check_update(value);
    true
}

#[tauri::command]
pub fn set_language(value: String) -> bool {
    Preferences::global().set_language(value);
    true
}

#[tauri::command]
pub fn get_check_update() -> bool {
    Preferences::global().get_check_update()
}

#[tauri::command]
pub fn get_language() -> String {
    Preferences::global().get_language()
}

#[tauri::command]
pub fn get_default_settings() -> serde_json::Value {
    let p = Preferences::global();
    serde_json::json!({
        "fft_bits": p.get_fft_bits(),
        "window_function": p.get_window_function(),
        "palette": p.get_palette(),
        "lrange": p.get_lrange(),
        "urange": p.get_urange(),
        "show_preview": p.get_show_preview(),
        "show_shortcuts": p.get_show_shortcuts(),
        "save_resolution": p.get_save_resolution(),
    })
}

#[tauri::command]
pub fn set_default_settings(settings: serde_json::Value) -> bool {
    let p = Preferences::global();
    if let Some(v) = settings.get("fft_bits").and_then(|v| v.as_u64()) { p.set_fft_bits(v as u8); }
    if let Some(v) = settings.get("window_function").and_then(|v| v.as_str()) { p.set_window_function(v.to_string()); }
    if let Some(v) = settings.get("palette").and_then(|v| v.as_str()) { p.set_palette(v.to_string()); }
    if let Some(v) = settings.get("lrange").and_then(|v| v.as_i64()) { p.set_lrange(v as i32); }
    if let Some(v) = settings.get("urange").and_then(|v| v.as_i64()) { p.set_urange(v as i32); }
    if let Some(v) = settings.get("show_preview").and_then(|v| v.as_bool()) { p.set_show_preview(v); }
    if let Some(v) = settings.get("show_shortcuts").and_then(|v| v.as_bool()) { p.set_show_shortcuts(v); }
    if let Some(v) = settings.get("save_resolution").and_then(|v| v.as_str()) { p.set_save_resolution(v.to_string()); }
    true
}

#[tauri::command]
pub fn get_config_path() -> String {
    crate::platform::config_path("spek").to_string_lossy().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeParams {
    pub path: String,
    pub stream: Option<usize>,
    pub channel: Option<usize>,
    pub window_function: Option<String>,
    pub fft_bits: Option<usize>,
    pub samples: Option<usize>,
    pub show_preview: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct ProgressBatchPayload {
    start_sample: usize,
    count: usize,
    bands: usize,
    data_u8: Vec<u8>,
}

static ANALYSIS_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub fn cancel_pipeline() -> bool {
    ANALYSIS_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    true
}

#[tauri::command]
pub async fn analyze_audio(
    window: tauri::Window,
    params: AnalyzeParams,
) -> Result<SpectrogramResult, String> {
    let stream = params.stream.unwrap_or(0);
    let channel = params.channel.unwrap_or(0);
    let wf_str = params.window_function.unwrap_or_else(|| "hann".to_string());
    let wf = WindowFunction::from_str(&wf_str);
    let fft_bits = params.fft_bits.unwrap_or(11);
    let samples = params.samples.unwrap_or(800);
    let show_preview = params
        .show_preview
        .unwrap_or_else(|| Preferences::global().get_show_preview());

    if !(8..=14).contains(&fft_bits) {
        return Err(format!("fft_bits out of range 8..14: {}", fft_bits));
    }

    // New generation counter for atomic cancellation
    let current_gen = ANALYSIS_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

    // Clone for blocking task
    let path = params.path.clone();
    let window_clone = window.clone();

    // Heavy work offloaded to blocking thread pool so UI stays responsive
    let result = tauri::async_runtime::spawn_blocking(move || {
        let is_cancelled = move || ANALYSIS_GENERATION.load(std::sync::atomic::Ordering::Relaxed) != current_gen;

        // Open and decode audio with live progress reporting and cancellation
        let window_decode = window_clone.clone();
        let on_decode_progress = move |decoded: usize, est: usize| {
            let percent = if est > 0 {
                ((decoded as f32 / est as f32) * 100.0).min(99.0) as u32
            } else {
                0
            };
            let _ = window_decode.emit("spectrogram-decode-progress", percent);
        };
        let info = audio::open_audio_file_with_cancel_and_progress(&path, stream, is_cancelled, on_decode_progress);
        if is_cancelled() {
            return SpectrogramResult {
                bands: crate::fft::bits_to_bands(fft_bits),
                samples: 0,
                sample_rate: info.sample_rate,
                duration: info.duration,
                codec_name: info.codec_name.clone(),
                bit_rate: info.bit_rate,
                bits_per_sample: info.bits_per_sample,
                channels: info.channels,
                streams: info.streams,
                desc: String::new(),
                magnitudes: vec![],
                error: String::new(),
            };
        }
        if info.error != audio::AudioError::Ok && info.error != audio::AudioError::NoDuration {
            return SpectrogramResult::error_result(&info);
        }
        if channel >= info.channels && info.channels != 0 {
            let mut r = SpectrogramResult::error_result(&info);
            r.error = format!("channel {} out of range for {} channels", channel, info.channels);
            return r;
        }

        if show_preview {
            let emit_batch = |start_sample: usize, count: usize, bands: usize, data_u8: &[u8]| {
                let payload = ProgressBatchPayload {
                    start_sample,
                    count,
                    bands,
                    data_u8: data_u8.to_vec(),
                };
                let _ = window_clone.emit("spectrogram-progress-batch", &payload);
            };
            crate::pipeline::run_pipeline_with_batch_emit_cancel(info, wf, fft_bits, samples, channel, stream, emit_batch, is_cancelled)
        } else {
            crate::pipeline::run_pipeline(info, wf, fft_bits, samples, channel, stream)
        }
    })
    .await
    .map_err(|e| format!("task join error: {}", e))?;

    // Check if inner error was encoded as channel out of range
    if result.error.starts_with("channel ") && result.error.contains("out of range") {
        return Err(result.error);
    }

    Ok(result)
}

#[tauri::command]
pub fn get_audio_info(path: String, stream: Option<usize>) -> Result<serde_json::Value, String> {
    let s = stream.unwrap_or(0);
    let info = audio::open_audio_file(&path, s);
    let wf = WindowFunction::Hann;
    let desc = crate::pipeline::pipeline_desc(&info, s, 0, wf, 11);
    Ok(serde_json::json!({
        "error": format!("{}", info.error),
        "error_code": format!("{:?}", info.error),
        "codec_name": info.codec_name,
        "bit_rate": info.bit_rate,
        "sample_rate": info.sample_rate,
        "bits_per_sample": info.bits_per_sample,
        "channels": info.channels,
        "streams": info.streams,
        "duration": info.duration,
        "frames": info.frames,
        "desc": desc,
    }))
}

#[tauri::command]
pub fn check_version() -> Result<serde_json::Value, String> {
    // Mirror spek-window.cc check_version thread
    // Check preferences, then fetch https://help.spek.cc/version
    let prefs = Preferences::global();
    if !prefs.get_check_update() {
        return Ok(serde_json::json!({ "should_check": false, "update_available": false }));
    }

    // Calculate days since 0001-01-01 similar to GLib/ wxDateTime
    let now = chrono::Local::now().date_naive();
    // Use chrono's num_days_from_ce? That counts from 0001-01-01
    let days = now.num_days_from_ce();

    let last = prefs.get_last_update() as i32;
    let diff = days - last;
    if diff < 7 && last != 0 {
        return Ok(serde_json::json!({ "should_check": false, "days_since_last": diff, "update_available": false }));
    }

    // Fetch version
    let version = fetch_remote_version().unwrap_or_default();
    if version.is_empty() {
        return Ok(serde_json::json!({ "should_check": true, "update_available": false, "error": "fetch failed" }));
    }

    let current = env!("CARGO_PKG_VERSION");
    let cmp = vercmp(&version, current);
    let update_available = cmp == 1;

    if update_available {
        // Don't auto-update last check? Original updates last check regardless of result after fetch
        // prefs.set_last_update(days);
    }
    // Update prefs
    prefs.set_last_update(days as i64);

    Ok(serde_json::json!({
        "should_check": true,
        "update_available": update_available,
        "remote_version": version,
        "current_version": current,
        "days_since_last": diff,
    }))
}

fn fetch_remote_version() -> Option<String> {
    // Use reqwest blocking
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client.get("https://help.spek.cc/version").send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().ok()?;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[tauri::command]
pub fn get_available_languages() -> Vec<(String, String)> {
    // From spek-preferences-dialog.cc
    vec![
        ("".to_string(), "".to_string()),
        ("".to_string(), "(system default)".to_string()),
        ("bs".to_string(), "Bosanski".to_string()),
        ("ca".to_string(), "Català".to_string()),
        ("cs".to_string(), "Čeština".to_string()),
        ("da".to_string(), "Dansk".to_string()),
        ("de".to_string(), "Deutsch".to_string()),
        ("el".to_string(), "Ελληνικά".to_string()),
        ("en".to_string(), "English".to_string()),
        ("eo".to_string(), "Esperanto".to_string()),
        ("es".to_string(), "Español".to_string()),
        ("fi".to_string(), "Suomi".to_string()),
        ("fr".to_string(), "Français".to_string()),
        ("gl".to_string(), "Galego".to_string()),
        ("he".to_string(), "עברית".to_string()),
        ("hr".to_string(), "Hrvatski".to_string()),
        ("hu".to_string(), "Magyar".to_string()),
        ("id".to_string(), "Bahasa Indonesia".to_string()),
        ("it".to_string(), "Italiano".to_string()),
        ("ja".to_string(), "日本語".to_string()),
        ("ko".to_string(), "한국어".to_string()),
        ("lv".to_string(), "Latviešu".to_string()),
        ("nb".to_string(), "Norsk (bokmål)".to_string()),
        ("nl".to_string(), "Nederlands".to_string()),
        ("nn".to_string(), "Norsk (nynorsk)".to_string()),
        ("pl".to_string(), "Polski".to_string()),
        ("pt_BR".to_string(), "Português brasileiro".to_string()),
        ("ru".to_string(), "Русский".to_string()),
        ("sk".to_string(), "Slovenčina".to_string()),
        ("sr@latin".to_string(), "Srpski".to_string()),
        ("sv".to_string(), "Svenska".to_string()),
        ("th".to_string(), "ไทย".to_string()),
        ("tr".to_string(), "Türkçe".to_string()),
        ("uk".to_string(), "Українська".to_string()),
        ("vi".to_string(), "Tiếng Việt".to_string()),
        ("zh_CN".to_string(), "中文(简体)".to_string()),
        ("zh_TW".to_string(), "中文(台灣)".to_string()),
    ]
}

#[tauri::command]
pub fn palette_color(palette: String, level: f64) -> u32 {
    let p = match palette.to_lowercase().as_str() {
        "spectrum" => crate::palette::Palette::Spectrum,
        "sox" => crate::palette::Palette::Sox,
        "mono" => crate::palette::Palette::Mono,
        _ => crate::palette::Palette::Sox,
    };
    crate::palette::palette_color(p, level)
}

#[tauri::command]
pub fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "Spektaurs",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Acoustic Spectrum Analyser",
        "copyright": "Copyright (c) 2010-2013 Alexander Kojevnikov and contributors. Spektaurs port (c) 2026.",
        "website": "https://github.com/iGerman00/spektaurs",
        "developers": [
            "Alexander Kojevnikov (Original Spek author)",
            "Spektaurs contributors",
            "Andreas Cadhalpun",
            "Colin Watson",
            "Daniel Hams",
            "Elias Ojala",
            "Fabian Deutsch",
            "Guillaume Fourrier",
            "Jakov Smolic",
            "Jonathan Gonzalez V",
            "Matteo Bini",
            "Mike Wang",
            "Simon Ruderich",
            "Stefan Kost",
            "Thibault North",
            "Wyatt J. Brown"
        ],
        "artist": "Olga Vasylevska (Original Spek artwork) & Karen Rustad Tölva (Ferris the Crab, public domain)",
        "license": "GPL-3.0"
    })
}

#[tauri::command]
pub fn get_cli_args() -> serde_json::Value {
    let args: Vec<String> = std::env::args().collect();
    // Mimic spek.cc: parse --help, --version, and optional FILE
    let mut help = false;
    let mut version = false;
    let mut file: Option<String> = None;
    for arg in args.iter().skip(1) {
        match arg.as_str() {
            "-h" | "--help" => help = true,
            "-V" | "--version" => version = true,
            _ if arg.starts_with('-') => {},
            _ => {
                if file.is_none() {
                    file = Some(arg.clone());
                }
            }
        }
    }
    serde_json::json!({
        "args": args,
        "help": help,
        "version": version,
        "file": file,
    })
}

// Needed for chrono days calculation
use chrono::Datelike;
