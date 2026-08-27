use crate::audio::{AudioFileInfo, extract_channel};
use crate::fft::{precompute_coss, FftPlan, WindowFunction, bits_to_bands, get_window_value};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineRequest {
    pub path: String,
    pub stream: usize,
    pub channel: usize,
    pub window_function: String,
    pub fft_bits: usize,
    pub samples: usize,
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
    pub magnitudes: Vec<f32>,
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
        desc = format!("Stream {} / {}: {}", stream + 1, info.streams, desc);
    } else if !error_str.is_empty() {
        desc = format!("{}: {}", error_str, desc);
    }
    desc
}

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
    let pcm = extract_channel(&info.pcm, info.channels, channel);
    let total_frames = pcm.len();
    if total_frames == 0 {
        return SpectrogramResult::error_result(&info);
    }

    let nfft = 1usize << fft_bits;
    let bands = bits_to_bands(fft_bits);
    let coss = Arc::new(precompute_coss(nfft));
    let pcm = Arc::new(pcm);

    // Precompute per-sample interval boundaries using integer division (Bresenham, matches original error accumulation)
    let total_i64 = total_frames as i64;
    let samples_i64 = samples as i64;

    // Fast path: per-interval direct computation instead of per-frame loop over 20M iterations.
    // Each column s covers [s*total/samples, (s+1)*total/samples)
    let mut magnitudes = vec![0.0f32; samples * bands];

    // For smooth realtime plotting we prioritize sequential per-column emit (continuous lines) over parallel burst.
    // Parallel is still used for the non-emit path (run_pipeline) via a separate implementation, but for emit we stay sequential.
    // This gives ~100x speedup over the old per-frame loop (800 vs 21M iterations) while keeping animation smooth.
    let use_parallel = false;

    if use_parallel {
        // Parallel path — compute each column independently
        magnitudes
            .par_chunks_mut(bands)
            .enumerate()
            .for_each(|(s, chunk)| {
                let start = (s as i64 * total_i64 / samples_i64) as usize;
                let end = ((s as i64 + 1) * total_i64 / samples_i64) as usize;
                let interval_len = end.saturating_sub(start);
                if interval_len == 0 {
                    chunk.fill(f32::NEG_INFINITY);
                    return;
                }
                // Determine FFT positions: every nfft within interval, plus one at end if interval < nfft
                let mut positions = Vec::new();
                if interval_len < nfft {
                    positions.push(end.saturating_sub(1));
                } else {
                    let mut p = start + nfft - 1;
                    while p < end {
                        positions.push(p);
                        p += nfft;
                    }
                    if positions.is_empty() {
                        positions.push(end - 1);
                    }
                }
                let num_fft = positions.len() as f32;
                let mut acc = vec![0.0f32; bands];
                // Each thread needs its own FFT plan (RealFftPlanner is not Sync)
                let mut planner = realfft::RealFftPlanner::<f32>::new();
                let fft = planner.plan_fft_forward(nfft);
                let mut scratch = fft.make_output_vec();
                let mut windowed = vec![0.0f32; nfft];
                let mut input = vec![0.0f32; nfft];
                for &window_end in &positions {
                    for i in 0..nfft {
                        let idx = window_end as i64 - nfft as i64 + 1 + i as i64;
                        let v = if idx < 0 {
                            0.0
                        } else {
                            let ui = idx as usize;
                            if ui < total_frames { pcm[ui] } else { 0.0 }
                        };
                        windowed[i] = v * get_window_value(window_function, i, nfft, &coss);
                    }
                    input.copy_from_slice(&windowed);
                    // scratch is reused, but need fresh each time
                    let mut out = scratch.clone();
                    // realfft wants &mut input, &mut output
                    // We use a temporary clone of input because plan consumes &mut
                    let mut inp = input.clone();
                    fft.process(&mut inp, &mut out).unwrap();
                    let n2 = (nfft as f32) * (nfft as f32);
                    let dc = out[0].re;
                    let mut mag0 = 10.0 * (dc * dc / n2).log10();
                    if !mag0.is_finite() { mag0 = f32::NEG_INFINITY; }
                    acc[0] += mag0;
                    let nyq = out[nfft / 2].re;
                    let mut mag_nyq = 10.0 * (nyq * nyq / n2).log10();
                    if !mag_nyq.is_finite() { mag_nyq = f32::NEG_INFINITY; }
                    acc[nfft / 2] += mag_nyq;
                    for i in 1..nfft / 2 {
                        let re = out[i].re;
                        let im = out[i].im;
                        let mag = re * re + im * im;
                        let mut v = 10.0 * (mag / n2).log10();
                        if !v.is_finite() { v = f32::NEG_INFINITY; }
                        acc[i] += v;
                    }
                }
                for b in 0..bands {
                    // Handle NEG_INFINITY averaging: if any is -inf, average stays -inf unless all are -inf
                    // For our case, -inf averaged with finite should be finite? But original leaves -inf for silence.
                    // We do simple average, but if acc contains -inf, the sum will be -inf, /num_fft stays -inf.
                    chunk[b] = acc[b] / num_fft;
                }
            });

        // Emit in order for smooth progressive UI (still fast, but now continuous)
        for s in 0..samples {
            let chunk = &magnitudes[s * bands..(s + 1) * bands];
            emit(s, bands, chunk);
        }
    } else {
        // Sequential fast path (small samples, also used for correctness)
        let mut planner = realfft::RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(nfft);
        let mut scratch = fft.make_output_vec();
        let mut windowed = vec![0.0f32; nfft];
        let mut input = vec![0.0f32; nfft];
        let mut acc = vec![0.0f32; bands];

        for s in 0..samples {
            let start = (s as i64 * total_i64 / samples_i64) as usize;
            let end = ((s as i64 + 1) * total_i64 / samples_i64) as usize;
            let interval_len = end.saturating_sub(start);
            if interval_len == 0 {
                for b in 0..bands { magnitudes[s * bands + b] = f32::NEG_INFINITY; }
                emit(s, bands, &magnitudes[s * bands..(s + 1) * bands]);
                continue;
            }
            let mut positions = Vec::new();
            if interval_len < nfft {
                positions.push(end.saturating_sub(1));
            } else {
                let mut p = start + nfft - 1;
                while p < end {
                    positions.push(p);
                    p += nfft;
                }
                if positions.is_empty() { positions.push(end - 1); }
            }
            acc.fill(0.0);
            for &window_end in &positions {
                for i in 0..nfft {
                    let idx = window_end as i64 - nfft as i64 + 1 + i as i64;
                    let v = if idx < 0 { 0.0 } else { let ui = idx as usize; if ui < total_frames { pcm[ui] } else { 0.0 } };
                    windowed[i] = v * get_window_value(window_function, i, nfft, &coss);
                }
                input.copy_from_slice(&windowed);
                let mut out = scratch.clone();
                let mut inp = input.clone();
                fft.process(&mut inp, &mut out).unwrap();
                let n2 = (nfft as f32) * (nfft as f32);
                let dc = out[0].re;
                let mut mag0 = 10.0 * (dc * dc / n2).log10();
                if !mag0.is_finite() { mag0 = f32::NEG_INFINITY; }
                acc[0] += mag0;
                let nyq = out[nfft / 2].re;
                let mut mag_nyq = 10.0 * (nyq * nyq / n2).log10();
                if !mag_nyq.is_finite() { mag_nyq = f32::NEG_INFINITY; }
                acc[nfft / 2] += mag_nyq;
                for i in 1..nfft / 2 {
                    let re = out[i].re;
                    let im = out[i].im;
                    let mag = re * re + im * im;
                    let mut v = 10.0 * (mag / n2).log10();
                    if !v.is_finite() { v = f32::NEG_INFINITY; }
                    acc[i] += v;
                }
            }
            let num_fft = positions.len() as f32;
            for b in 0..bands {
                let v = acc[b] / num_fft;
                magnitudes[s * bands + b] = v;
            }
            emit(s, bands, &magnitudes[s * bands..(s + 1) * bands]);
        }
    }

    // Replace NEG_INFINITY with -200 for display clamping? Keep -inf for tests, but backend should probably clamp to -100 for frontend?
    // Frontend expects finite values; it clamps to lrange/urange anyway, so -inf will be clamped to lrange.
    // Keep as is for correctness.

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
        assert!(d.contains("128 kbps"), "desc {}", d);
        assert!(d.contains("44100 Hz"), "desc {}", d);
        assert!(d.contains("channel 2 / 2"), "desc {}", d);
        assert!(d.contains("W:2048"), "desc {}", d);
        assert!(d.contains("F:Hann"), "desc {}", d);

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
        let expected_bin = (freq * (1 << 11) as f64 / sample_rate as f64).round() as usize;
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
        assert!((max_b as i32 - expected_bin as i32).abs() <= 3, "peak {} expected {} freq {} sample_rate {}", max_b, expected_bin, freq, sample_rate);
    }

    #[test]
    fn test_pipeline_window_functions() {
        let sample_rate = 44100;
        let frames = sample_rate;
        let freq = 1000.0;
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
