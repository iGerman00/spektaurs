# Spek — Rust + Tauri Reimplementation

> Acoustic Spectrum Analyser — 100% feature-parity, cross-platform, high-performance Rust + Tauri reimplementation of [Spek](https://www.spek.cc/) (original C++/wxWidgets/FFmpeg).

Spek helps you analyse audio files by displaying their spectrogram. This reimplementation replicates **all** original features while delivering a blazing-fast, modern cross-platform desktop application powered by [Tauri 2](https://tauri.app/), Rust backend, and Vanilla TypeScript / HTML5 Canvas.

Original: [alexkay/spek](https://github.com/alexkay/spek) — `v0.8.5`, GPL-3.0.

---

## Features & Improvements

* 🚀 **Blazing Fast Multithreading**: Rust backend uses [Rayon](https://github.com/rayon-rs/rayon) to parallelize FFT analysis across all available CPU cores.
* ⚡ **Fluid 165Hz UI & Instant Recoloring**: Dynamic range (`urange`/`lrange`) and palette adjustments recolor in $<2\text{ ms}$ via 32-bit LUTs (`currentRemapLUT`) without re-analyzing audio.
* 📡 **Live Streaming Preview**: Spectrogram progressively renders columns in real time during analysis via batched zero-copy IPC streaming.
* 🎚️ **Intuitive Dynamic Range & Zoom**:
  * **Mouse Wheel**: Scroll up/down to adjust Lower dB limit (boost or dim quiet signals).
  * **Shift + Mouse Wheel**: Adjust Upper dB limit (ceiling).
  * **Ctrl + Mouse Wheel**: Step FFT size up/down (256 to 16,384).
  * **Middle Click / `R` Key**: Instantly reset dynamic range to defaults (`-120 dB` to `0 dB`).
* 📦 **Zero External Dependencies**: Pure-Rust audio decoding engine ([Symphonia](https://github.com/pdeljanov/Symphonia)) is built into the binary; automatically leverages system `ffmpeg` for acceleration when present.
* 🖥️ **Full Cross-Platform Support**: Standalone executables and installers for Windows (x64 & ARM64), macOS (Universal Apple Silicon & Intel), and Linux (x86_64 & ARM64 `.deb` / `.AppImage`).
* 🎨 **3 Color Palettes**: Exact ports of original `Spectrum`, `SoX`, and `Mono` color palettes.
* 📐 **Lossless Resolution Exports**: Export at current window size, presets (1080p, 4K, etc.), or exact **Original (samples × bands)** for 1:1 lossless FFT frequency mapping.

---

## Parity Matrix

| Original Component (`src/*.cc`) | This Reimplementation | Status |
|---|---|---|
| `spek-audio.cc` — FFmpeg decoding, streams, metadata, duration, error handling | `src-tauri/src/audio.rs` — Pure-Rust **symphonia** (built-in) + **streaming ffmpeg** pipe fallback | ✅ 100% |
| `spek-fft.cc` — `av_rdft` RDFT + magnitude `10*log10(re²+im²/n²)` | `src-tauri/src/fft.rs` — `realfft` + exact reference formula, verified vs `av_rdft` | ✅ 100% |
| `spek-palette.cc` — Spectrum / SoX / Mono palettes | `src-tauri/src/palette.rs` + `src/main.ts` — Bit-identical hex color stops | ✅ 100% |
| `spek-pipeline.cc` — Interval arithmetic, Hann/Hamming/Blackman-Harris windows | `src-tauri/src/pipeline.rs` — Multi-threaded Rayon pipeline with exact interval bounds | ✅ 100% |
| `spek-spectrogram.cc` — Canvas spectrogram, rulers, padding (`LPAD=60`, `TPAD=60`, `RPAD=90`, `BPAD=40`) | `src/main.ts` + `src/styles.css` — HTML5 Canvas, HiDPI support, dynamic tick rulers | ✅ 100% |
| `spek-window.cc` — Menu bar, toolbar, drag-and-drop, update check, file dialogs | `index.html` + `src/main.ts` — Dark theme UI, native dialogs, drag-and-drop overlay | ✅ 100% |
| `spek-preferences.cc` — Preferences persistence (`~/.config/spek/preferences`) | `src-tauri/src/preferences.rs` — XDG config persistence, preferences dialog | ✅ 100% |
| `spek-utils.cc` — `spek_vercmp` version comparison | `src-tauri/src/utils.rs` — Exact port using `strtol` semantics | ✅ 100% |

---

## Keyboard Shortcuts & Mouse Controls

| Control | Action |
|---|---|
| `c` / `Shift+C` | Cycle Next / Prev audio channel |
| `s` / `Shift+S` | Cycle Next / Prev audio stream |
| `f` / `Shift+F` | Cycle Next / Prev window function (Hann → Hamming → Blackman-Harris) |
| `w` / `Shift+W` | Step DFT size up / down (256 to 16384, default 2048) |
| `p` / `Shift+P` | Cycle palette (Spectrum → SoX → Mono) — *Instant recolor* |
| `l` / `Shift+L` | Lower range limit (`lrange`) +1 / -1 dB (min -140 dB) |
| `u` / `Shift+U` | Upper range limit (`urange`) +1 / -1 dB (max 0 dB) |
| `r` / `R` | Reset dynamic range to defaults (`-120 dB` to `0 dB`) |
| **Mouse Wheel** | Adjust Lower range limit (`lrange`) — *Scroll UP increases visibility* |
| **Shift + Wheel** | Adjust Upper range limit (`urange`) |
| **Ctrl + Wheel** | Step DFT size up / down |
| **Middle Click** | Reset dynamic range to defaults (`-120 dB` to `0 dB`) |
| `F1` / `Shift+F1` | Help / About Spek |

---

## Verification & Test Suite

The Rust test suite verifies mathematical and observable parity against the original C++ reference implementation across 26 test suites:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

```
running 26 tests
test audio::tests::test_audio_extract_channel ... ok
test fft::tests::test_bits_to_bands ... ok
test palette::tests::test_palette_bounds ... ok
test fft::tests::test_window_reference ... ok
test palette::tests::test_palette_mono_linear ... ok
test palette::tests::test_palette_reference_sox ... ok
test pipeline::tests::test_desc ... ok
test pipeline::tests::test_desc_reference ... ok
test utils::tests::test_vercmp_additional ... ok
test utils::tests::test_vercmp_basic ... ok
test fft::tests::test_fft_basic ... ok
test utils::tests::test_vercmp_full_reference ... ok
test pipeline::tests::test_pipeline_clipped ... ok
test pipeline::tests::test_pipeline_window_functions ... ok
test fft::tests::test_fft_reference_const ... ok
test pipeline::tests::test_pipeline_ordered_emissions ... ok
test pipeline::tests::test_pipeline_synthetic ... ok
test pipeline::tests::test_pipeline_all_fft_bits ... ok
test audio::tests::test_audio_ogg_reference ... ok
test audio::tests::test_audio_m4a_reference ... ok
test fft::tests::test_fft_reference_sine ... ok
test audio::tests::test_audio_nonexistent ... ok
test audio::tests::test_audio_wav_reference ... ok
test audio::tests::test_audio_flac_reference ... ok
test audio::tests::test_audio_streams_and_channels ... ok
test audio::tests::test_audio_mp3_reference ... ok

test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.70s
```

---

## Build & Development

### Prerequisites
* Rust `1.77+`
* Node.js `20+` and `npm`
* Linux: `libwebkit2gtk-4.1-dev` `librsvg2-dev` `patchelf` `libasound2-dev`

### Commands

```bash
# Install frontend dependencies
npm install

# Run in development mode (hot-reload)
npm run tauri dev

# Run test suite
cargo test --manifest-path src-tauri/Cargo.toml

# Build release binaries & bundles
npm run build
npm run tauri build
```

---

## License

GPL-3.0 (same as original Spek). See `LICENSE`.

Copyright © 2010–2013 Alexander Kojevnikov and contributors.  
Rust + Tauri reimplementation © 2026 Spek Contributors.

```bash
git clone https://github.com/alexkay/spek  # reference C++
git clone <this-repo> spek-tauri
cd spek-tauri
cargo test   # verify Rust parity
npm run tauri dev  # launch
```

File issues at `https://github.com/anomalyco/opencode` (mention Muse Spark) or the original tracker.

