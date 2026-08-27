use realfft::RealToComplex;
use rustfft::num_complex::Complex;
use std::sync::Arc;

/// Window function matching spek-pipeline.h
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WindowFunction {
    #[default]
    Hann = 0,
    Hamming = 1,
    BlackmanHarris = 2,
}

impl WindowFunction {
    pub fn from_index(idx: i32) -> Self {
        match idx {
            0 => WindowFunction::Hann,
            1 => WindowFunction::Hamming,
            2 => WindowFunction::BlackmanHarris,
            _ => WindowFunction::Hann,
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "hann" => WindowFunction::Hann,
            "hamming" => WindowFunction::Hamming,
            "blackman" | "blackman-harris" | "blackman_harris" => {
                WindowFunction::BlackmanHarris
            }
            _ => WindowFunction::Hann,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            WindowFunction::Hann => "Hann",
            WindowFunction::Hamming => "Hamming",
            WindowFunction::BlackmanHarris => "Blackman–Harris",
        }
    }
}

/// FFT plan mirroring spek-fft.h / spek-fft.cc
/// Input size = 1 << nbits, Output size = (1 << (nbits-1))+1
pub struct FftPlan {
    nbits: usize,
    n: usize,
    input_size: usize,
    output_size: usize,
    // realfft plan
    r2c: Arc<dyn RealToComplex<f32>>,
    // buffers
    input: Vec<f32>,
    output: Vec<f32>,
    scratch: Vec<Complex<f32>>,
}

impl FftPlan {
    pub fn new(nbits: usize) -> Self {
        assert!((4..=15).contains(&nbits), "nbits out of range");
        let n = 1usize << nbits;
        let input_size = n;
        let output_size = (1usize << (nbits - 1)) + 1;

        let mut planner = realfft::RealFftPlanner::<f32>::new();
        let r2c = planner.plan_fft_forward(n);

        let input = vec![0.0f32; n];
        let output = vec![0.0f32; output_size];
        let scratch = r2c.make_output_vec();

        Self {
            nbits,
            n,
            input_size,
            output_size,
            r2c,
            input,
            output,
            scratch,
        }
    }

    pub fn nbits(&self) -> usize {
        self.nbits
    }
    pub fn input_size(&self) -> usize {
        self.input_size
    }
    pub fn output_size(&self) -> usize {
        self.output_size
    }
    pub fn n(&self) -> usize {
        self.n
    }

    pub fn set_input(&mut self, idx: usize, val: f32) {
        self.input[idx] = val;
    }

    pub fn get_output(&self, idx: usize) -> f32 {
        self.output[idx]
    }

    /// Execute FFT and compute magnitudes in dB
    /// Equivalent to av_rdft_calc + magnitude loop in spek-fft.cc
    pub fn execute(&mut self) {
        // realfft expects input &mut, output &mut [Complex]
        // We need to make a copy of input because r2c.process modifies? It takes &mut [f32] input
        // Use scratch buffer
        let mut scratch = self.scratch.clone();
        // Need to provide mutable input; clone input into temp?
        let mut input_clone = self.input.clone();
        self.r2c
            .process(&mut input_clone, &mut scratch)
            .expect("FFT failed");

        // Compute magnitudes: 10*log10( (re^2+im^2) / n^2 )
        // For real FFT: scratch[0] is DC (real), scratch[n/2] is Nyquist (real)
        // But realfft output length = n/2+1, each Complex: re = real part, im = imag
        // For k=0: im=0, magnitude from re only (stored in scratch[0].re)
        // For k=n/2: similar (stored in scratch[n/2].re)
        // Our output mapping matches original: output[0] = DC, output[n/2]=Nyquist, output[i] for 1..n/2-1
        let n2 = (self.n as f32) * (self.n as f32);
        // DC
        let dc = scratch[0].re;
        self.output[0] = 10.0 * (dc * dc / n2).log10();
        // Nyquist
        let nyq = scratch[self.n / 2].re;
        self.output[self.n / 2] = 10.0 * (nyq * nyq / n2).log10();

        for (out, &c) in self.output[1..self.n / 2].iter_mut().zip(&scratch[1..self.n / 2]) {
            let re = c.re;
            let im = c.im;
            let mag = re * re + im * im;
            *out = 10.0 * (mag / n2).log10();
        }

        // Preserve -inf for silence (do not clamp to -200) to match reference C++ behavior
        // Original av_rdft produces -inf for zero magnitude; our display can handle -inf
        // No clamping here; let -inf remain for tests
    }

    /// Convenience: execute on provided windowed input slice and return output clone
    pub fn execute_with_input(&mut self, windowed: &[f32]) -> Vec<f32> {
        assert_eq!(windowed.len(), self.n);
        self.input.copy_from_slice(windowed);
        self.execute();
        self.output.clone()
    }
}

pub fn bits_to_bands(bits: usize) -> usize {
    (1usize << (bits - 1)) + 1
}

pub fn get_window_value(func: WindowFunction, i: usize, n: usize, coss: &[f32]) -> f32 {
    match func {
        WindowFunction::Hann => 0.5 * (1.0 - coss[i]),
        WindowFunction::Hamming => 0.53836 - 0.46164 * coss[i],
        WindowFunction::BlackmanHarris => {
            0.35875 - 0.48829 * coss[i] + 0.14128 * coss[(2 * i) % n] - 0.01168 * coss[(3 * i) % n]
        }
    }
}

pub fn precompute_coss(n: usize) -> Vec<f32> {
    let cf = 2.0 * std::f32::consts::PI / (n as f32 - 1.0);
    (0..n).map(|i| (cf * i as f32).cos()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    const FFT_BITS_MIN: usize = 4;
    const FFT_BITS_MAX: usize = 15;

    #[test]
    fn test_fft_basic() {
        let mut plan = FftPlan::new(11);
        assert_eq!(plan.input_size(), 2048);
        assert_eq!(plan.output_size(), 1025);
        // Fill with sine wave at 440Hz, sample rate 44100
        let sr = 44100.0;
        let freq = 440.0;
        for i in 0..plan.input_size() {
            let s = (2.0 * std::f32::consts::PI * freq * i as f32 / sr).sin();
            plan.set_input(i, s);
        }
        plan.execute();
        // Should have peak near bin 440*2048/44100 ≈ 20
        let mut max_idx = 0;
        let mut max_val = f32::NEG_INFINITY;
        for i in 0..plan.output_size() {
            if plan.get_output(i) > max_val {
                max_val = plan.get_output(i);
                max_idx = i;
            }
        }
        assert!((10..30).contains(&max_idx));
    }

    #[test]
    fn test_fft_reference_const() {
        // Mirrors test-fft.cc::test_const
        for nbits in FFT_BITS_MIN..=FFT_BITS_MAX {
            let mut plan = FftPlan::new(nbits);
            assert_eq!(plan.input_size(), 1 << nbits);
            assert_eq!(plan.output_size(), (1 << nbits) / 2 + 1);

            // Test zero input.
            for i in 0..plan.input_size() {
                plan.set_input(i, 0.0);
            }
            plan.execute();
            let mut silence = true;
            for i in 0..plan.output_size() {
                if plan.get_output(i) > -1e12f32 {
                    silence = false;
                    break;
                }
            }
            assert!(silence, "silence failed for nbits {}", nbits);

            // Test DC input (all 1.0)
            for i in 0..plan.input_size() {
                plan.set_input(i, 1.0);
            }
            plan.execute();
            let dc = plan.get_output(0);
            assert!((dc - 0.0).abs() < 0.01, "dc component nbits {} got {} expected 0.0", nbits, dc);
            let mut silence = true;
            for i in 1..plan.output_size() {
                if plan.get_output(i) > -1e12f32 {
                    silence = false;
                    break;
                }
            }
            assert!(silence, "dc silence failed for nbits {}", nbits);
        }
    }

    #[test]
    fn test_fft_reference_sine() {
        // Mirrors test-fft.cc::test_sine
        for nbits in FFT_BITS_MIN..=FFT_BITS_MAX {
            let mut plan = FftPlan::new(nbits);
            let n = plan.input_size();
            let mut k = 1;
            while k < n / 2 {
                for i in 0..n {
                    plan.set_input(i, (k as f64 * i as f64 * 2.0 * std::f64::consts::PI / n as f64).sin() as f32);
                }
                plan.execute();
                let val = plan.get_output(k);
                // Original test: static_cast<int>(plan->get_output(k) * 100) == -602
                // => -6.02 dB *100 truncated to int -602
                // Allow tolerance: within 0.05 dB => within 5 in int*100
                let int_val = (val * 100.0) as i32;
                assert_eq!(int_val, -602, "sine k={} nbits={} got {} ({}) expected -602", k, nbits, val, int_val);
                let mut silence = true;
                for i in 0..plan.output_size() {
                    if i == k { continue; }
                    if plan.get_output(i) > -149.0f32 {
                        silence = false;
                        // Find offending bin for debug
                        // println!("nbits {} k {} offending {} val {}", nbits, k, i, plan.get_output(i));
                        break;
                    }
                }
                assert!(silence, "sine silence failed nbits {} k {}", nbits, k);
                k *= 2;
            }
        }
    }

    #[test]
    fn test_window_reference() {
        // Reference values from C++ window_test
        let n = 2048;
        let coss = precompute_coss(n);
        let cases: Vec<(usize, WindowFunction, f32)> = vec![
            (0, WindowFunction::Hann, 0.000000),
            (0, WindowFunction::Hamming, 0.076720),
            (0, WindowFunction::BlackmanHarris, 0.000060),
            (1, WindowFunction::Hann, 0.000002),
            // (1, WindowFunction::Hamming, 0.076722) etc approximate
            (512, WindowFunction::Hann, 0.500384),
            (1023, WindowFunction::Hann, 0.999999),
        ];
        for (idx, wf, expected) in cases {
            let got = get_window_value(wf, idx, n, &coss);
            assert!((got - expected).abs() < 1e-4, "window {:?} idx {} got {} expected {}", wf, idx, got, expected);
        }
        // Additional symmetry checks
        assert!((get_window_value(WindowFunction::Hann, 0, n, &coss) - 0.0).abs() < 1e-5);
        assert!((get_window_value(WindowFunction::Hann, 2047, n, &coss) - 0.0).abs() < 1e-5);
        assert!((get_window_value(WindowFunction::Hamming, 0, n, &coss) - 0.07672).abs() < 1e-4);
    }

    #[test]
    fn test_bits_to_bands() {
        assert_eq!(bits_to_bands(8), 129);
        assert_eq!(bits_to_bands(11), 1025);
        assert_eq!(bits_to_bands(14), 8193);
    }
}
