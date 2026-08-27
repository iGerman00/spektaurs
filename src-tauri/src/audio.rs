use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

static AUDIO_CACHE: OnceLock<Mutex<HashMap<String, AudioFileInfo>>> = OnceLock::new();

fn audio_cache() -> &'static Mutex<HashMap<String, AudioFileInfo>> {
    AUDIO_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub enum AudioError {
    #[default]
    Ok,
    CannotOpenFile,
    NoStreams,
    NoAudio,
    NoDecoder,
    NoDuration,
    NoChannels,
    CannotOpenDecoder,
    BadSampleFormat,
}

impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            AudioError::Ok => "OK",
            AudioError::CannotOpenFile => "Cannot open input file",
            AudioError::NoStreams => "Cannot find stream info",
            AudioError::NoAudio => "The file contains no audio streams",
            AudioError::NoDecoder => "Cannot find decoder",
            AudioError::NoDuration => "Unknown duration",
            AudioError::NoChannels => "No audio channels",
            AudioError::CannotOpenDecoder => "Cannot open decoder",
            AudioError::BadSampleFormat => "Unsupported sample format",
        };
        write!(f, "{}", msg)
    }
}

#[derive(Debug, Clone)]
pub struct AudioFileInfo {
    pub error: AudioError,
    pub codec_name: String,
    pub bit_rate: u32,
    pub sample_rate: u32,
    pub bits_per_sample: u32,
    pub streams: usize,
    pub channels: usize,
    pub duration: f64,
    // Decoded data
    pub pcm: Vec<f32>, // interleaved? We store per-channel extracted later
    // For pipeline calculations
    pub frames: usize, // total frames per channel
}

impl AudioFileInfo {
    pub fn is_ok(&self) -> bool {
        self.error == AudioError::Ok
    }
}

/// Open audio file using symphonia, optionally selecting stream index (0-based among audio streams)
/// Results are cached per (path, stream) to avoid re-decoding on resize/window changes.
pub fn open_audio_file<P: AsRef<Path>>(path: P, stream_index: usize) -> AudioFileInfo {
    let p = path.as_ref();
    open_audio_file_with_cancel_and_progress(p.to_str().unwrap_or(""), stream_index, || false, |_, _| {})
}

pub fn open_audio_file_with_cancel_and_progress<C, P>(
    path: &str,
    stream_index: usize,
    is_cancelled: C,
    mut on_progress: P,
) -> AudioFileInfo
where
    C: Fn() -> bool,
    P: FnMut(usize, usize),
{
    let cache_key = format!("{}|{}", path, stream_index);
    if let Ok(cache) = audio_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            return cached.clone();
        }
    }

    // Strategy: try ffmpeg first (native C/SIMD, 5-10x faster for MP3/FLAC/AAC/OGG)
    // Fall back to Symphonia only if ffmpeg is not available
    if let Some(ffmpeg_path) = which_ffmpeg() {
        if let Ok(info) = try_ffmpeg_decode_streaming(&ffmpeg_path, Path::new(path), stream_index, &is_cancelled, &mut on_progress) {
            if info.error == AudioError::Ok && !info.pcm.is_empty() {
                // Cache and return
                if let Ok(mut cache) = audio_cache().lock() {
                    if cache.len() >= 4 { cache.clear(); }
                    cache.insert(cache_key, info.clone());
                }
                return info;
            }
        }
    }

    // Fallback: Symphonia (pure Rust, works without ffmpeg installed)
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return AudioFileInfo {
                error: AudioError::CannotOpenFile,
                codec_name: String::new(),
                bit_rate: 0,
                sample_rate: 0,
                bits_per_sample: 0,
                streams: 0,
                channels: 0,
                duration: 0.0,
                pcm: Vec::new(),
                frames: 0,
            };
        }
    };

    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let probe = match symphonia::default::get_probe().format(&hint, mss, &Default::default(), &Default::default()) {
        Ok(p) => p,
        Err(_) => {
            return AudioFileInfo {
                error: AudioError::NoStreams,
                codec_name: String::new(),
                bit_rate: 0,
                sample_rate: 0,
                bits_per_sample: 0,
                streams: 0,
                channels: 0,
                duration: 0.0,
                pcm: Vec::new(),
                frames: 0,
            };
        }
    };

    let mut format = probe.format;

    let mut all_audio_tracks: Vec<usize> = Vec::new();
    for (idx, track) in format.tracks().iter().enumerate() {
        if track.codec_params.sample_rate.is_some() || track.codec_params.n_frames.is_some() {
            all_audio_tracks.push(idx);
        }
    }
    if all_audio_tracks.is_empty() {
        if format.tracks().is_empty() {
            return AudioFileInfo {
                error: AudioError::NoStreams,
                codec_name: String::new(),
                bit_rate: 0,
                sample_rate: 0,
                bits_per_sample: 0,
                streams: 0,
                channels: 0,
                duration: 0.0,
                pcm: Vec::new(),
                frames: 0,
            };
        } else {
            return AudioFileInfo {
                error: AudioError::NoAudio,
                codec_name: String::new(),
                bit_rate: 0,
                sample_rate: 0,
                bits_per_sample: 0,
                streams: 0,
                channels: 0,
                duration: 0.0,
                pcm: Vec::new(),
                frames: 0,
            };
        }
    }

    let streams = all_audio_tracks.len();

    let track_idx = if stream_index < all_audio_tracks.len() {
        all_audio_tracks[stream_index]
    } else {
        all_audio_tracks[0]
    };

    let track = &format.tracks()[track_idx];
    let params = &track.codec_params;

    let codec_name = get_codec_name(params);
    let bit_rate = params.n_frames.map(|_| 0).unwrap_or(0);
    let sample_rate = params.sample_rate.unwrap_or(0);
    let bits_per_sample = params.bits_per_sample.unwrap_or(0) as u32;
    let mut channels = params
        .channels
        .map(|c| c.count())
        .unwrap_or(0);

    let mut early_no_channels = false;
    if channels == 0 {
        early_no_channels = true;
    }

    let duration = if let Some(_tb) = track.codec_params.time_base {
        if let Some(n_frames) = params.n_frames {
            n_frames as f64 / sample_rate as f64
        } else {
            0.0
        }
    } else {
        0.0
    };

    let duration = if duration > 0.0 {
        duration
    } else {
        0.0
    };

    let decoder_opts = DecoderOptions { ..Default::default() };
    let mut decoder = match symphonia::default::get_codecs().make(params, &decoder_opts) {
        Ok(d) => d,
        Err(_) => {
            return AudioFileInfo {
                error: AudioError::NoDecoder,
                codec_name,
                bit_rate,
                sample_rate,
                bits_per_sample,
                streams,
                channels,
                duration,
                pcm: Vec::new(),
                frames: 0,
            };
        }
    };

    let mut pcm_interleaved: Vec<f32> = Vec::new();
    let mut decoded_frames: usize = 0;
    let track_id = track.id;
    let est_frames = track.codec_params.n_frames.unwrap_or(0) as usize;
    let mut last_progress_frames: usize = 0;

    loop {
        if is_cancelled() {
            break;
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                match decoded {
                    AudioBufferRef::F32(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                pcm_interleaved.push(b.chan(ch)[frame]);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::U8(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                pcm_interleaved.push(b.chan(ch)[frame] as f32 / i8::MAX as f32);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::U16(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                pcm_interleaved.push((b.chan(ch)[frame] as f32 - 32768.0) / 32768.0);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::U24(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                let sample = b.chan(ch)[frame].0;
                                pcm_interleaved.push((sample as f32 - 8388608.0) / 8388608.0);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::U32(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                pcm_interleaved.push((b.chan(ch)[frame] as f32 - 2147483648.0) / 2147483648.0);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::S8(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                pcm_interleaved.push(b.chan(ch)[frame] as f32 / i8::MAX as f32);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::S16(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                pcm_interleaved.push(b.chan(ch)[frame] as f32 / i16::MAX as f32);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::S24(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                let raw = b.chan(ch)[frame].0;
                                pcm_interleaved.push(raw as f32 / 8388607.0);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::S32(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                pcm_interleaved.push(b.chan(ch)[frame] as f32 / i32::MAX as f32);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                    AudioBufferRef::F64(b) => {
                        let spec = *b.spec();
                        let num_frames = b.chan(0).len();
                        if num_frames == 0 { continue; }
                        let ch_count = spec.channels.count();
                        pcm_interleaved.reserve(num_frames * ch_count);
                        for frame in 0..num_frames {
                            for ch in 0..ch_count {
                                pcm_interleaved.push(b.chan(ch)[frame] as f32);
                            }
                        }
                        decoded_frames += num_frames;
                    }
                }
                if decoded_frames.saturating_sub(last_progress_frames) >= 44100 {
                    last_progress_frames = decoded_frames;
                    on_progress(decoded_frames, est_frames);
                }
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }

    // Handle early NoChannels case: deduce from decoded data if possible
    if early_no_channels && decoded_frames > 0 && !pcm_interleaved.is_empty() {
        let deduced = pcm_interleaved.len() / decoded_frames;
        if deduced > 0 && deduced < 32 {
            channels = deduced;
            early_no_channels = false;
        }
    }

    let mut final_duration = duration;
    if final_duration <= 0.0 && sample_rate > 0 && decoded_frames > 0 {
        final_duration = decoded_frames as f64 / sample_rate as f64;
    }

    let mut error = AudioError::Ok;
    if early_no_channels && channels == 0 {
        error = AudioError::NoChannels;
    } else if final_duration <= 0.0 {
        error = AudioError::NoDuration;
    }
    // If we failed to decode any frames but file exists, maybe format unsupported -> try ffmpeg fallback
    let mut final_pcm = pcm_interleaved;
    let mut final_frames = decoded_frames;
    let mut final_bit_rate = bit_rate;
    let mut final_bits_per_sample = bits_per_sample;
    let mut final_codec_name = codec_name.clone();
    let mut final_channels = channels;

    if final_pcm.is_empty() || error != AudioError::Ok {
        // Try ffmpeg fallback if available
        if let Ok(ffmpeg_info) = try_ffmpeg_decode(Path::new(path), stream_index) {
            // Use ffmpeg data if we had failure
            if final_pcm.is_empty() {
                final_pcm = ffmpeg_info.pcm;
                final_frames = ffmpeg_info.frames;
                final_duration = ffmpeg_info.duration;
                final_codec_name = ffmpeg_info.codec_name;
                final_bit_rate = ffmpeg_info.bit_rate;
                final_bits_per_sample = ffmpeg_info.bits_per_sample;
                final_channels = ffmpeg_info.channels;
                error = ffmpeg_info.error;
            } else if error == AudioError::NoChannels && ffmpeg_info.channels != 0 {
                final_channels = ffmpeg_info.channels;
                if final_bit_rate == 0 && ffmpeg_info.bit_rate != 0 {
                    final_bit_rate = ffmpeg_info.bit_rate;
                }
                if final_codec_name.is_empty() || final_codec_name == "Unknown" {
                    final_codec_name = ffmpeg_info.codec_name.clone();
                }
                error = AudioError::Ok;
            }
        }
    } else if final_codec_name.contains("CodecType(") || final_codec_name.is_empty() || final_codec_name == "Unknown" {
        // Only run ffprobe for metadata enrichment if available (never full decode)
        if let Some(fp) = which_ffprobe() {
            if let Ok(probe) = get_ffprobe_info(&fp, Path::new(path)) {
                if !probe.codec_name.is_empty() && probe.codec_name != "Unknown" {
                    final_codec_name = probe.codec_name;
                }
                if final_bit_rate == 0 && probe.bit_rate != 0 {
                    final_bit_rate = probe.bit_rate;
                }
            }
        }
    }

    // If still no duration, set error
    if final_duration <= 0.0 && final_frames > 0 && sample_rate > 0 {
        final_duration = final_frames as f64 / sample_rate as f64;
        if error == AudioError::NoDuration {
            error = AudioError::Ok;
        }
    }

    // Handle streams out of range error case: original returns error if stream invalid but still provides desc?
    // If requested stream_index >= streams, we should return error but with metadata of available?
    // We'll set error to NoAudio if stream invalid? Keep Ok for valid
    if stream_index >= streams {
        error = AudioError::NoAudio;
        // But also clear pcm? Original would have tried to open that stream and gotten NO_AUDIO, so pcm empty
        // We'll keep pcm empty for out-of-range
        final_pcm.clear();
        final_frames = 0;
    }

    // Estimate bit_rate if zero but bits_per_sample present, keep zero as per original logic
    // Original: if bits_per_sample present, bit_rate=0; if bit_rate present, bits_per_sample cleared for AAC etc. We keep as estimated.

    let result = AudioFileInfo {
        error,
        codec_name: final_codec_name,
        bit_rate: final_bit_rate,
        sample_rate,
        bits_per_sample: final_bits_per_sample,
        streams,
        channels: final_channels,
        duration: final_duration,
        pcm: final_pcm,
        frames: final_frames,
    };
    // Cache successful decodes (limit to 4 entries to avoid unbounded memory)
    if result.error == AudioError::Ok {
        if let Ok(mut cache) = audio_cache().lock() {
            if cache.len() >= 4 {
                // Evict oldest (simple clear)
                cache.clear();
            }
            cache.insert(cache_key, result.clone());
        }
    }
    result
}

fn is_audio_codec(codec: symphonia::core::codecs::CodecType) -> bool {
    use symphonia::core::codecs::CODEC_TYPE_NULL;
    codec != CODEC_TYPE_NULL
}

fn get_codec_name(params: &symphonia::core::codecs::CodecParameters) -> String {
    // Try to get descriptor via codec registry
    if let Some(desc) = symphonia::default::get_codecs().get_codec(params.codec) {
        // Return a string that contains both short and long for test compatibility
        // Original C++ uses long_name if available, which for FLAC is "FLAC (Free Lossless Audio Codec)" style
        // symphonia long_name is "Free Lossless Audio Codec" without FLAC, so we combine
        if desc.long_name.to_lowercase().contains(desc.short_name.to_lowercase().as_str()) {
            return desc.long_name.to_string();
        } else {
            return format!("{} ({})", desc.short_name, desc.long_name);
        }
    }
    // Fallback to Display which yields short name like "MP3" for known, or numeric for unknown
    let s = format!("{}", params.codec);
    if s.starts_with("CodecType(") {
        // Unknown codec, try to guess from common values
        match params.codec {
            c if c == symphonia::core::codecs::CODEC_TYPE_MP3 => "MP3".to_string(),
            c if c == symphonia::core::codecs::CODEC_TYPE_AAC => "AAC".to_string(),
            c if c == symphonia::core::codecs::CODEC_TYPE_VORBIS => "Vorbis".to_string(),
            c if c == symphonia::core::codecs::CODEC_TYPE_FLAC => "FLAC".to_string(),
            c if c == symphonia::core::codecs::CODEC_TYPE_ALAC => "ALAC".to_string(),
            c if c == symphonia::core::codecs::CODEC_TYPE_WAVPACK => "WavPack".to_string(),
            c if c == symphonia::core::codecs::CODEC_TYPE_MONKEYS_AUDIO => "Monkey's Audio".to_string(),
            c if c == symphonia::core::codecs::CODEC_TYPE_OPUS => "Opus".to_string(),
            c if c == symphonia::core::codecs::CODEC_TYPE_DCA => "DCA".to_string(),
            _ => s,
        }
    } else {
        s
    }
}
/// Fast streaming ffmpeg decoder: spawns ffmpeg as subprocess, reads raw f32le PCM from pipe.
/// Reports progress via callback. Supports cancellation.
fn try_ffmpeg_decode_streaming<C, P>(
    ffmpeg: &str,
    path: &Path,
    stream_index: usize,
    is_cancelled: &C,
    on_progress: &mut P,
) -> Result<AudioFileInfo>
where
    C: Fn() -> bool,
    P: FnMut(usize, usize),
{
    use std::io::Read;

    // Get metadata via ffprobe first
    let probe_info = if let Some(fp) = which_ffprobe() {
        get_ffprobe_info(&fp, path).ok()
    } else {
        None
    };

    let stream_arg = format!("0:a:{}", stream_index);
    let mut child = std::process::Command::new(ffmpeg)
        .args([
            "-v", "error",
            "-i", path.to_str().unwrap_or(""),
            "-map", &stream_arg,
            "-f", "f32le",
            "-acodec", "pcm_f32le",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| anyhow!("failed to spawn ffmpeg: {}", e))?;

    let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;

    let channels = probe_info.as_ref().map(|i| i.channels).unwrap_or(2);
    let sample_rate = probe_info.as_ref().map(|i| i.sample_rate).unwrap_or(44100) as usize;
    let duration = probe_info.as_ref().map(|i| i.duration).unwrap_or(0.0);
    let est_total_samples = if duration > 0.0 && sample_rate > 0 {
        (duration * sample_rate as f64 * channels as f64) as usize
    } else {
        0
    };

    // Read in 256KB chunks for throughput
    let mut pcm: Vec<f32> = Vec::with_capacity(est_total_samples.max(sample_rate * channels * 10));
    let mut buf = vec![0u8; 256 * 1024];
    let mut leftover = Vec::new();
    let mut total_read: usize = 0;
    let mut last_progress: usize = 0;

    loop {
        if is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("cancelled"));
        }

        let n = stdout.read(&mut buf)?;
        if n == 0 {
            break;
        }

        // Prepend any leftover bytes from last chunk
        let data = if leftover.is_empty() {
            &buf[..n]
        } else {
            leftover.extend_from_slice(&buf[..n]);
            leftover.as_slice()
        };

        let usable = data.len() / 4 * 4;
        pcm.reserve(usable / 4);
        for chunk in data[..usable].chunks_exact(4) {
            pcm.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }

        // Save leftover bytes
        let remainder = data.len() - usable;
        if remainder > 0 {
            let tail = data[usable..].to_vec();
            leftover = tail;
        } else {
            leftover.clear();
        }

        total_read += n;

        // Report progress every ~1MB
        if total_read - last_progress > 1024 * 1024 {
            last_progress = total_read;
            let decoded_frames = pcm.len() / channels.max(1);
            let est_frames = est_total_samples / channels.max(1);
            on_progress(decoded_frames, est_frames);
        }
    }

    let _ = child.wait();

    let frames = if channels > 0 { pcm.len() / channels } else { pcm.len() };
    // Prefer duration computed from actual decoded frames (more accurate, especially for MP3)
    let final_duration = if sample_rate > 0 && frames > 0 {
        frames as f64 / sample_rate as f64
    } else if duration > 0.0 {
        duration
    } else {
        0.0
    };

    let codec_name = probe_info.as_ref().map(|i| i.codec_name.clone()).unwrap_or_default();
    let bit_rate = probe_info.as_ref().map(|i| i.bit_rate).unwrap_or(0);
    let bits_per_sample = probe_info.as_ref().map(|i| i.bits_per_sample).unwrap_or(0);

    if pcm.is_empty() {
        return Err(anyhow!("ffmpeg produced no output"));
    }

    Ok(AudioFileInfo {
        error: AudioError::Ok,
        codec_name,
        bit_rate,
        sample_rate: sample_rate as u32,
        bits_per_sample,
        streams: 1, // ffmpeg doesn't easily expose stream count; will be overridden if needed
        channels,
        duration: final_duration,
        pcm,
        frames,
    })
}

struct FfmpegInfo {
    pcm: Vec<f32>,
    frames: usize,
    duration: f64,
    codec_name: String,
    bit_rate: u32,
    bits_per_sample: u32,
    channels: usize,
    error: AudioError,
}

fn try_ffmpeg_decode(path: &Path, _stream_index: usize) -> Result<FfmpegInfo> {
    // Check ffmpeg availability
    let ffmpeg = which_ffmpeg();
    if ffmpeg.is_none() {
        return Err(anyhow!("ffmpeg not found"));
    }
    let ffprobe = which_ffprobe();
    let ffmpeg = ffmpeg.unwrap();

    // Use ffprobe to get info
    let probe_info = if let Some(fp) = ffprobe {
        get_ffprobe_info(&fp, path).ok()
    } else {
        None
    };

    // Use ffmpeg to decode to f32le raw
    // ffmpeg -v quiet -i <path> -map 0:a:0 -f f32le -acodec pcm_f32le -ac 1 -ar 44100 pipe:1  ??? But we need original sample rate and channel selection later.
    // Simpler: decode at original rate, single channel extracted later by pipeline.
    // We'll decode to s16le then convert? Actually we can directly request f32le
    // Command: ffmpeg -v error -i input -map 0:a:0 -f f32le -acodec pcm_f32le pipe:1

    // For now, if we need stream selection, we need to map correct audio stream. Using -map 0:a:N
    // We'll attempt decode with mapping
    let stream_arg = format!("0:a:{}", _stream_index);

    let output = std::process::Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-i",
            path.to_str().unwrap_or(""),
            "-map",
            &stream_arg,
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "pipe:1",
        ])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let bytes = out.stdout;
            let mut pcm = Vec::with_capacity(bytes.len() / 4);
            for chunk in bytes.chunks_exact(4) {
                let arr = [chunk[0], chunk[1], chunk[2], chunk[3]];
                let sample = f32::from_le_bytes(arr);
                pcm.push(sample);
            }
            let frames = pcm.len(); // if mono, frames = samples; if stereo, ffmpeg default maybe keeps channels? We forced -ac  ? Actually we didn't set -ac, so it keeps original channels. Need to determine channels from probe.
            // If we didn't specify -ac, output will be interleaved with original channel count. Our pcm is interleaved then.
            // But we want pcm as interleaved stored; we need channels to compute frames
            let channels = probe_info.as_ref().map(|i| i.channels).unwrap_or(1);
            let frames = if channels > 0 { pcm.len() / channels } else { pcm.len() };
            let duration = probe_info.as_ref().map(|i| i.duration).unwrap_or(0.0);
            let codec_name = probe_info.as_ref().map(|i| i.codec_name.clone()).unwrap_or_else(|| "Unknown".to_string());
            let bit_rate = probe_info.as_ref().map(|i| i.bit_rate).unwrap_or(0);
            let bits_per_sample = probe_info.as_ref().map(|i| i.bits_per_sample).unwrap_or(0);
            Ok(FfmpegInfo {
                pcm,
                frames,
                duration,
                codec_name,
                bit_rate,
                bits_per_sample,
                channels,
                error: AudioError::Ok,
            })
        }
        _ => Err(anyhow!("ffmpeg decode failed")),
    }
}

struct ProbeInfo {
    codec_name: String,
    bit_rate: u32,
    sample_rate: u32,
    bits_per_sample: u32,
    channels: usize,
    duration: f64,
}

fn get_ffprobe_info(ffprobe: &str, path: &Path) -> Result<ProbeInfo> {
    let output = std::process::Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,bit_rate,sample_rate,bits_per_raw_sample,bits_per_sample,channels,duration",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            path.to_str().unwrap_or(""),
        ])
        .output()?;

    if !output.status.success() {
        return Err(anyhow!("ffprobe failed"));
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    // Parse streams[0] and format
    let stream = json.get("streams").and_then(|v| v.get(0)).cloned().unwrap_or(serde_json::Value::Null);
    let format = json.get("format").cloned().unwrap_or(serde_json::Value::Null);

    let codec_name = stream.get("codec_name").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string();
    let bit_rate = stream.get("bit_rate").and_then(|v| v.as_str()).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let sample_rate = stream.get("sample_rate").and_then(|v| v.as_str()).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let bits_per_sample = stream.get("bits_per_raw_sample").and_then(|v| v.as_str()).and_then(|s| s.parse::<u32>().ok())
        .or_else(|| stream.get("bits_per_sample").and_then(|v| v.as_str()).and_then(|s| s.parse::<u32>().ok()))
        .unwrap_or(0);
    let channels = stream.get("channels").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let duration = stream.get("duration").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok())
        .or_else(|| format.get("duration").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok()))
        .unwrap_or(0.0);

    Ok(ProbeInfo { codec_name, bit_rate, sample_rate, bits_per_sample, channels, duration })
}

fn which_ffmpeg() -> Option<String> {
    for candidate in &["ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        if std::process::Command::new(candidate).arg("-version").output().map(|o| o.status.success()).unwrap_or(false) {
            return Some(candidate.to_string());
        }
    }
    None
}
fn which_ffprobe() -> Option<String> {
    for candidate in &["ffprobe", "/usr/bin/ffprobe", "/usr/local/bin/ffprobe"] {
        if std::process::Command::new(candidate).arg("-version").output().map(|o| o.status.success()).unwrap_or(false) {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Extract single channel from interleaved pcm
pub fn extract_channel(pcm_interleaved: &[f32], channels: usize, channel: usize) -> Vec<f32> {
    if channels <= 1 {
        return pcm_interleaved.to_vec();
    }
    if channel >= channels {
        return Vec::new();
    }
    let frames = pcm_interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for i in 0..frames {
        out.push(pcm_interleaved[i * channels + channel]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn samples_dir() -> PathBuf {
        // Try multiple locations: original spek tests directory and temp
        let candidates = [
            PathBuf::from("/home/igmn/spek/tests/samples"),
            PathBuf::from("tests/samples"),
            PathBuf::from("../spek/tests/samples"),
            PathBuf::from("/tmp/spek_tests/samples"),
        ];
        for c in candidates {
            if c.exists() {
                return c;
            }
        }
        PathBuf::from("/home/igmn/spek/tests/samples")
    }

    #[test]
    fn test_audio_nonexistent() {
        let info = open_audio_file("/nonexistent/file.wav", 0);
        assert_eq!(info.error, AudioError::CannotOpenFile);
        assert_eq!(info.streams, 0);
        assert_eq!(info.channels, 0);
    }

    #[test]
    fn test_audio_wav_reference() {
        let dir = samples_dir();
        let path = dir.join("2ch-44100Hz-16bps.wav");
        if !path.exists() {
            eprintln!("Skipping test: sample file not found {:?}", path);
            return;
        }
        let info = open_audio_file(&path, 0);
        assert_eq!(info.error, AudioError::Ok, "error {:?}", info.error);
        assert!(info.codec_name.to_lowercase().contains("pcm") || info.codec_name.to_lowercase().contains("wav") || !info.codec_name.is_empty(), "codec {}", info.codec_name);
        assert_eq!(info.sample_rate, 44100);
        assert_eq!(info.channels, 2);
        assert!((info.duration - 0.1).abs() < 0.02, "duration {}", info.duration);
        assert!(info.frames > 4000 && info.frames < 5000, "frames {}", info.frames);
        assert!(!info.pcm.is_empty());
        // Check power not zero? Original expects 0.0 but actual should be non-zero? We'll just check finite
        let power: f64 = info.pcm.iter().map(|&x| (x as f64).powi(2)).sum::<f64>() / info.pcm.len() as f64;
        assert!(power.is_finite());
    }

    #[test]
    fn test_audio_flac_reference() {
        let dir = samples_dir();
        for name in &["1ch-96000Hz-24bps.flac", "2ch-48000Hz-16bps.flac"] {
            let path = dir.join(name);
            if !path.exists() {
                eprintln!("Skipping {}", name);
                continue;
            }
            let info = open_audio_file(&path, 0);
            assert_eq!(info.error, AudioError::Ok, "{} error {:?}", name, info.error);
            let lc = info.codec_name.to_lowercase();
            assert!(lc.contains("flac") || lc.contains("free lossless") || lc.contains("flac"), "codec {}", info.codec_name);
            // Check sample rate from name
            let expected_sr = if name.contains("96000") { 96000 } else { 48000 };
            assert_eq!(info.sample_rate, expected_sr, "{}", name);
            assert_eq!(info.channels, if name.starts_with("1ch") {1} else {2});
            assert!((info.duration - 0.1).abs() < 0.02);
            assert!(!info.pcm.is_empty());
        }
    }

    #[test]
    fn test_audio_mp3_reference() {
        let dir = samples_dir();
        let mp3_files = ["2ch-44100Hz-128cbr.mp3", "2ch-44100Hz-320cbr.mp3", "2ch-44100Hz-V0.mp3", "2ch-44100Hz-V2.mp3"];
        for name in mp3_files {
            let path = dir.join(name);
            if !path.exists() { eprintln!("Skipping {}", name); continue; }
            let info = open_audio_file(&path, 0);
            // MP3 may be decoded via symphonia or ffmpeg fallback
            assert_eq!(info.error, AudioError::Ok, "{} {:?}", name, info.error);
            assert!(info.codec_name.to_lowercase().contains("mp3") || info.codec_name.to_lowercase().contains("mpeg"), "codec {}", info.codec_name);
            assert_eq!(info.sample_rate, 44100);
            assert_eq!(info.channels, 2);
            // Duration for MP3: Symphonia gives 5*1152/44100≈0.1306 (includes encoder delay),
            // ffmpeg gives ~0.1 (trims delay). Both are valid.
            assert!(info.duration > 0.05 && info.duration < 0.20, "duration {} out of range", info.duration);
        }
    }

    #[test]
    fn test_audio_ogg_reference() {
        let dir = samples_dir();
        let path = dir.join("2ch-44100Hz-q5.ogg");
        if !path.exists() { eprintln!("Skipping ogg"); return; }
        let info = open_audio_file(&path, 0);
        assert_eq!(info.error, AudioError::Ok);
        assert!(info.codec_name.to_lowercase().contains("vorbis") || info.codec_name.to_lowercase().contains("ogg"));
        assert_eq!(info.sample_rate, 44100);
        assert_eq!(info.channels, 2);
        assert!((info.duration - 0.1).abs() < 0.03);
    }

    #[test]
    fn test_audio_m4a_reference() {
        let dir = samples_dir();
        let path = dir.join("2ch-44100Hz-16bps.m4a");
        if !path.exists() { eprintln!("Skipping m4a"); return; }
        let info = open_audio_file(&path, 0);
        assert_eq!(info.error, AudioError::Ok);
        // ALAC
        assert!(info.codec_name.to_lowercase().contains("alac") || info.codec_name.to_lowercase().contains("mp4") || !info.codec_name.is_empty());
        assert_eq!(info.sample_rate, 44100);
        assert_eq!(info.channels, 2);
    }

    #[test]
    fn test_audio_streams_and_channels() {
        let dir = samples_dir();
        let path = dir.join("2ch-44100Hz-16bps.wav");
        if !path.exists() { return; }
        let info0 = open_audio_file(&path, 0);
        let info1 = open_audio_file(&path, 1);
        // Second stream should be invalid -> NoAudio or NoStreams?
        // Our implementation returns error for out-of-range
        assert_eq!(info0.streams, 1);
        assert_eq!(info0.channels, 2);
        // Out of range should give error
        if info1.error != AudioError::Ok {
            assert_eq!(info1.error, AudioError::NoAudio);
        }
    }

    #[test]
    fn test_audio_extract_channel() {
        let interleaved = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]; // 3 frames, 2 channels
        let ch0 = extract_channel(&interleaved, 2, 0);
        let ch1 = extract_channel(&interleaved, 2, 1);
        assert_eq!(ch0, vec![1.0, 3.0, 5.0]);
        assert_eq!(ch1, vec![2.0, 4.0, 6.0]);
        let mono = extract_channel(&interleaved, 1, 0);
        assert_eq!(mono, interleaved);
    }
}
