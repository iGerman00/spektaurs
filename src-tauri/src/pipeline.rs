use crate::audio::{AudioFileInfo, extract_channel};
use crate::fft::{precompute_coss, FftPlan, WindowFunction, bits_to_bands, get_window_value};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineRequest {
    pub path: String,
    pub stream: usize,
    pub channel: usize,
    pub window_function: String,
    pub fft_bits: usize,
    pub samples: usize, // number of pixels (width - LPAD - RPAD)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpectrogramResult {
    pub bands: usize,
    pub samples: usize,
    pub sample_rate: u32,
    pub duration: f64,
    pub codec_name: String,
    pub bit_rate: u32,
    pub bits_per_sample: u32,
    pub channels: usize,
    pub streams: usize,
    pub desc: String,
    pub magnitudes: Vec<f32>, // flattened samples * bands, row-major? Let's use samples columns, each column has bands values bottom->top? We'll store band-major per sample: index = sample * bands + band
    pub error: String,
}

impl SpectrogramResult {
    pub fn error_result(info: &AudioFileInfo) -> Self {
        Self {
            bands: 0,
            samples: 0,
            sample_rate: info.sample_rate,
            duration: info.duration,
            codec_name: info.codec_name.clone(),
            bit_rate: info.bit_rate,
            bits_per_sample: info.bits_per_sample,
            channels: info.channels,
            streams: info.streams,
            desc: pipeline_desc(info, 0, 0, WindowFunction::Hann, 11),
            magnitudes: vec![],
            error: info.error.to_string(),
        }
    }
}

pub fn pipeline_desc(
    info: &AudioFileInfo,
    stream: usize,
    channel: usize,
    window_function: WindowFunction,
    fft_bits: usize,
) -> String {
    let mut items: Vec<String> = Vec::new();

    if !info.codec_name.is_empty() {
        items.push(info.codec_name.clone());
    }

    if info.bit_rate != 0 {
        items.push(format!("{} kbps", (info.bit_rate + 500) / 1000));
    }

    if info.sample_rate != 0 {
        items.push(format!("{} Hz", info.sample_rate));
    }

    if info.bits_per_sample != 0 && info.bit_rate == 0 {
        let bps = info.bits_per_sample;
        if bps == 1 {
            items.push(format!("{} bit", bps));
        } else {
            items.push(format!("{} bits", bps));
        }
    }

    if info.channels != 0 {
        items.push(format!("channel {} / {}", channel + 1, info.channels));
    }

    if info.error == crate::audio::AudioError::Ok {
        let nfft = 1usize << fft_bits;
        items.push(format!("W:{}", nfft));
        items.push(format!("F:{}", window_function.name()));
    }

    let mut desc = items.join(", ");

    let error_str = match info.error {
        crate::audio::AudioError::CannotOpenFile => "Cannot open input file",
        crate::audio::AudioError::NoStreams => "Cannot find stream info",
        crate::audio::AudioError::NoAudio => "The file contains no audio streams",
        crate::audio::AudioError::NoDecoder => "Cannot find decoder",
        crate::audio::AudioError::NoDuration => "Unknown duration",
        crate::audio::AudioError::NoChannels => "No audio channels",
        crate::audio::AudioError::CannotOpenDecoder => "Cannot open decoder",
        crate::audio::AudioError::BadSampleFormat => "Unsupported sample format",
        crate::audio::AudioError::Ok => "",
    };

    if desc.is_empty() {
        desc = error_str.to_string();
    } else if stream < info.streams {
        // show Stream X / Y: desc
        desc = format!("Stream {} / {}: {}", stream + 1, info.streams, desc);
    } else if !error_str.is_empty() {
        desc = format!("{}: {}", error_str, desc);
    }

    desc
}

/// Main pipeline function - synchronous, emulates spek-pipeline.cc worker logic
pub fn run_pipeline(
    info: AudioFileInfo,
    window_function: WindowFunction,
    fft_bits: usize,
    samples: usize,
    channel: usize,
    stream: usize,
) -> SpectrogramResult {
    run_pipeline_with_emit(info, window_function, fft_bits, samples, channel, stream, |_, _, _| {})
}

pub fn run_pipeline_with_emit<F>(
    info: AudioFileInfo,
    window_function: WindowFunction,
    fft_bits: usize,
    samples: usize,
    channel: usize,
    stream: usize,
    mut emit: F,
) -> SpectrogramResult
where
    F: FnMut(usize, usize, &[f32]),
{
    if info.error != crate::audio::AudioError::Ok {
        return SpectrogramResult::error_result(&info);
    }

    if samples == 0 {
        return SpectrogramResult {
            bands: bits_to_bands(fft_bits),
            samples: 0,
            sample_rate: info.sample_rate,
            duration: info.duration,
            codec_name: info.codec_name.clone(),
            bit_rate: info.bit_rate,
            bits_per_sample: info.bits_per_sample,
            channels: info.channels,
            streams: info.streams,
            desc: pipeline_desc(&info, stream, channel, window_function, fft_bits),
            magnitudes: vec![],
            error: String::new(),
        };
    }

    // Extract channel
    let pcm = extract_channel(&info.pcm, info.channels, channel);
    let total_frames = pcm.len();

    if total_frames == 0 {
        return SpectrogramResult::error_result(&info);
    }

    // Handle case where info.frames may be smaller than pcm len? Use pcm len
    let nfft = 1usize << fft_bits;
    let bands = bits_to_bands(fft_bits);

    // Precompute window coefficients
    let coss = precompute_coss(nfft);
    let mut fft_plan = FftPlan::new(fft_bits);

    // Reusable windowed buffer to avoid allocation per FFT
    let mut windowed = vec![0.0f32; nfft];

    // Interval calculation mimicking AudioFileImpl::start + worker_func
    let total_frames_i64 = total_frames as i64;
    let samples_i64 = samples as i64;
    let frames_per_interval = total_frames_i64 / samples_i64;
    let error_per_interval = total_frames_i64 % samples_i64;
    let error_base = samples_i64;

    // Worker state
    let mut magnitudes = vec![0.0f32; samples * bands];
    let mut output = vec![0.0f32; bands];
    let mut frames: i64 = 0;
    let mut num_fft: usize = 0;
    let mut acc_error: i64 = 0;
    let mut sample_idx: usize = 0;

    let mut head: usize = 0;

    while head < total_frames && sample_idx < samples {
        frames += 1;

        let int_full = acc_error < error_base && frames == frames_per_interval;
        let int_over = acc_error >= error_base && frames == 1 + frames_per_interval;

        let should_fft = (frames % nfft as i64 == 0) || ((int_full || int_over) && num_fft == 0);

        if should_fft {
            for i in 0..nfft {
                let idx = head as i64 - nfft as i64 + 1 + i as i64;
                let val = if idx < 0 {
                    0.0
                } else if (idx as usize) < total_frames {
                    pcm[idx as usize]
                } else {
                    0.0
                };
                let w = get_window_value(window_function, i, nfft, &coss);
                windowed[i] = val * w;
            }
            for (j, &v) in windowed.iter().enumerate() {
                fft_plan.set_input(j, v);
            }
            fft_plan.execute();
            num_fft += 1;
            for b in 0..bands {
                output[b] += fft_plan.get_output(b);
            }
        }

        if int_full || int_over {
            if int_over {
                acc_error -= error_base;
            } else {
                acc_error += error_per_interval;
            }

            if num_fft > 0 {
                for b in 0..bands {
                    output[b] /= num_fft as f32;
                }
            }

            for b in 0..bands {
                magnitudes[sample_idx * bands + b] = output[b];
            }

            // Emit progress for realtime plotting
            emit(sample_idx, bands, &output);

            sample_idx += 1;
            frames = 0;
            num_fft = 0;
            output.fill(0.0);

            if sample_idx >= samples {
                break;
            }
        }

        head += 1;
    }

    SpectrogramResult {
        bands,
        samples,
        sample_rate: info.sample_rate,
        duration: info.duration,
        codec_name: info.codec_name.clone(),
        bit_rate: info.bit_rate,
        bits_per_sample: info.bits_per_sample,
        channels: info.channels,
        streams: info.streams,
        desc: pipeline_desc(&info, stream, channel, window_function, fft_bits),
        magnitudes,
        error: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::AudioFileInfo;

    #[test]
    fn test_desc() {
        let info = AudioFileInfo {
            error: crate::audio::AudioError::Ok,
            codec_name: "FLAC".to_string(),
            bit_rate: 0,
            sample_rate: 48000,
            bits_per_sample: 16,
            streams: 1,
            channels: 2,
            duration: 0.1,
            pcm: vec![],
            frames: 0,
        };
        let d = pipeline_desc(&info, 0, 0, WindowFunction::Hann, 11);
        assert!(d.contains("FLAC"));
        assert!(d.contains("48000 Hz"));
    }

    #[test]
    fn test_desc_reference() {
        // Reproduce pipeline_desc logic cases from pipeline.cc
        // Bitrate case
        let info = AudioFileInfo {
            error: crate::audio::AudioError::Ok,
            codec_name: "MP3".to_string(),
            bit_rate: 128000,
            sample_rate: 44100,
            bits_per_sample: 0,
            streams: 1,
            channels: 2,
            duration: 5.0,
            pcm: vec![],
            frames: 0,
        };
        let d = pipeline_desc(&info, 0, 1, WindowFunction::Hann, 11);
        // Should contain 128 kbps, channel 2 /2, W:2048, F:Hann, stream info
        assert!(d.contains("128 kbps"), "desc {}", d);
        assert!(d.contains("44100 Hz"), "desc {}", d);
        assert!(d.contains("channel 2 / 2"), "desc {}", d);
        assert!(d.contains("W:2048"), "desc {}", d);
        assert!(d.contains("F:Hann"), "desc {}", d);

        // BPS case (when bit_rate 0)
        let info2 = AudioFileInfo {
            error: crate::audio::AudioError::Ok,
            codec_name: "FLAC".to_string(),
            bit_rate: 0,
            sample_rate: 96000,
            bits_per_sample: 24,
            streams: 1,
            channels: 1,
            duration: 0.1,
            pcm: vec![],
            frames: 0,
        };
        let d2 = pipeline_desc(&info2, 0, 0, WindowFunction::Hamming, 11);
        assert!(d2.contains("24 bits") || d2.contains("24 bit"), "desc {}", d2);
        assert!(!d2.contains("kbps"), "should not contain kbps when bps present");

        // Error case
        let info3 = AudioFileInfo {
            error: crate::audio::AudioError::CannotOpenFile,
            codec_name: "".to_string(),
            bit_rate: 0,
            sample_rate: 0,
            bits_per_sample: 0,
            streams: 0,
            channels: 0,
            duration: 0.0,
            pcm: vec![],
            frames: 0,
        };
        let d3 = pipeline_desc(&info3, 0, 0, WindowFunction::Hann, 11);
        assert!(d3.contains("Cannot open input file"), "desc {}", d3);
    }

    #[test]
    fn test_pipeline_synthetic() {
        // Generate synthetic sine wave and verify pipeline produces expected peak
        let sample_rate = 44100;
        let duration = 0.5;
        let freq = 1000.0;
        let frames = (sample_rate as f64 * duration) as usize;
        let mut pcm = Vec::with_capacity(frames);
        for i in 0..frames {
            let s = (2.0 * std::f64::consts::PI * freq * i as f64 / sample_rate as f64).sin() as f32;
            pcm.push(s);
        }
        let info = AudioFileInfo {
            error: crate::audio::AudioError::Ok,
            codec_name: "PCM".to_string(),
            bit_rate: 0,
            sample_rate: 44100,
            bits_per_sample: 16,
            streams: 1,
            channels: 1,
            duration,
            pcm: pcm.clone(),
            frames,
        };
        let result = run_pipeline(info, WindowFunction::Hann, 11, 100, 0, 0);
        assert_eq!(result.bands, bits_to_bands(11));
        assert_eq!(result.samples, 100);
        assert_eq!(result.magnitudes.len(), 100 * result.bands);
        // Find max band averaged across samples should be near freq bin
        let expected_bin = (freq * (1 << 11) as f64 / sample_rate as f64).round() as usize;
        // Average across columns: compute mean per band
        let mut band_sums = vec![0.0f32; result.bands];
        for s in 0..result.samples {
            for b in 0..result.bands {
                band_sums[b] += result.magnitudes[s * result.bands + b];
            }
        }
        for b in 0..result.bands { band_sums[b] /= result.samples as f32; }
        let mut max_b = 0;
        let mut max_v = f32::NEG_INFINITY;
        for (i, &v) in band_sums.iter().enumerate() {
            if v > max_v { max_v = v; max_b = i; }
        }
        // Allow ±3 bins tolerance due to windowing and averaging
        assert!((max_b as i32 - expected_bin as i32).abs() <= 3, "peak {} expected {} freq {} sample_rate {}", max_b, expected_bin, freq, sample_rate);
    }

    #[test]
    fn test_pipeline_window_functions() {
        // Ensure different window functions produce different outputs but same dimensions
        // Use sine wave at non-integer bin to maximize spectral leakage differences between windows
        let sample_rate = 44100;
        let frames = sample_rate; // 1 sec
        let freq = 1000.0; // non-bin frequency for n=2048 (bin 46.44)
        let mut pcm = Vec::with_capacity(frames);
        for i in 0..frames {
            let s = (2.0 * std::f64::consts::PI * freq * i as f64 / sample_rate as f64).sin() as f32 * 0.8;
            pcm.push(s);
        }
        let base_info = AudioFileInfo {
            error: crate::audio::AudioError::Ok,
            codec_name: "PCM".to_string(),
            bit_rate: 0,
            sample_rate: 44100,
            bits_per_sample: 16,
            streams: 1,
            channels: 1,
            duration: 1.0,
            pcm: pcm.clone(),
            frames,
        };
        let r1 = run_pipeline(base_info.clone(), WindowFunction::Hann, 11, 10, 0, 0);
        let r2 = run_pipeline(base_info.clone(), WindowFunction::Hamming, 11, 10, 0, 0);
        let r3 = run_pipeline(base_info, WindowFunction::BlackmanHarris, 11, 10, 0, 0);
        assert_eq!(r1.magnitudes.len(), r2.magnitudes.len());
        let diff: f32 = r1.magnitudes.iter().zip(r2.magnitudes.iter()).map(|(a,b)| (a-b).abs()).sum();
        assert!(diff > 0.5, "different windows should produce different results, diff={}", diff);
        let diff2: f32 = r2.magnitudes.iter().zip(r3.magnitudes.iter()).map(|(a,b)| (a-b).abs()).sum();
        assert!(diff2 > 0.5, "diff2={}", diff2);
    }
}
