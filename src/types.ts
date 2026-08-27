export type WindowFn = "hann" | "hamming" | "blackman-harris";
export type Palette = "spectrum" | "sox" | "mono";

export interface State {
  path: string;
  stream: number;
  channel: number;
  windowFunction: WindowFn;
  fftBits: number;
  palette: Palette;
  lrange: number;
  urange: number;
  sampleRate: number;
  duration: number;
  codecName: string;
  bitRate: number;
  bitsPerSample: number;
  channels: number;
  streams: number;
  desc: string;
  samples: number;
  bands: number;
  displayHeight: number;
  magnitudes?: number[];
  error?: string;
}

export interface SpectrogramResult {
  bands: number;
  samples: number;
  sample_rate: number;
  duration: number;
  codec_name: string;
  bit_rate: number;
  bits_per_sample: number;
  channels: number;
  streams: number;
  desc: string;
  magnitudes: number[];
  error: string;
}

export interface ProgressBatchPayload {
  start_sample: number;
  count: number;
  bands: number;
  data_u8: number[];
}

export interface AppSettings {
  window_function: string;
  fft_bits: number;
  palette: string;
  lrange: number;
  urange: number;
  show_preview?: boolean;
  show_shortcuts?: boolean;
  save_resolution?: string;
}

// Layout constants (scaled by DPR)
export const LPAD = 60;
export const TPAD = 60;
export const RPAD = 90;
export const BPAD = 40;
export const GAP = 10;
export const RULER = 10;

export const MIN_RANGE = -140;
export const MAX_RANGE = 0;
export const LRANGE_DEFAULT = -120;
export const URANGE_DEFAULT = 0;
export const MIN_FFT_BITS = 8;
export const MAX_FFT_BITS = 14;
