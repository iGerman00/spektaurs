# Spektaurs — Rust + Tauri Reimplementation

> Acoustic Spectrum Analyser — 100% feature-parity, cross-platform, high-performance Rust + Tauri reimplementation of [Spek](https://www.spek.cc/) (original C++/wxWidgets/FFmpeg).

Spektaurs helps you analyse audio files by displaying their spectrogram. This reimplementation replicates **all** original features while delivering a blazing-fast, modern cross-platform desktop application powered by [Tauri 2](https://tauri.app/), Rust backend, and Vanilla TypeScript / HTML5 Canvas.

Original: [alexkay/spek](https://github.com/alexkay/spek) — `v0.8.5`, GPL-3.0.

---

## Features & Improvements

* 🚀 **Blazing Fast Multithreading**: Rust backend uses [Rayon](https://github.com/rayon-rs/rayon) to parallelize FFT analysis across all available CPU cores.
* ⚡ **Fluid 165Hz UI & Instant Recoloring**: Dynamic range (`urange`/`lrange`) and palette adjustments recolor in $<2\text{ ms}$ via 32-bit LUTs (`currentRemapLUT`) without re-analyzing audio.
* 🖥️ **Instant Native Startup & Smooth Resize**: Zero white-flash instant native window initialization, with 60–165 FPS live responsive canvas scaling on window resizing.
* 📡 **Live Streaming Preview**: Spectrogram progressively renders columns in real time during analysis via batched zero-copy IPC streaming.
* 🎚️ **Intuitive Dynamic Range & Controls**:
  * **Mouse Wheel**: Scroll up/down to adjust Lower dB limit (boost or dim quiet signals).
  * **Shift + Mouse Wheel**: Adjust Upper dB limit (ceiling).
  * **Middle Click / `R` Key**: Instantly reset dynamic range to defaults (`-120 dB` to `0 dB`).
  * **Standard Shortcuts**: `Ctrl/⌘ + ,` for Preferences, `Ctrl/⌘ + S` to Save, `Ctrl/⌘ + O` to Open, `Ctrl/⌘ + W` to Close.
* 📦 **Zero External Dependencies**: Pure-Rust audio decoding engine ([Symphonia](https://github.com/pdeljanov/Symphonia)) is built into the binary; automatically leverages system `ffmpeg` when present.
* 🖥️ **Full Cross-Platform Support**: Standalone executables and installers for Windows (x64 & ARM64), macOS (Universal Apple Silicon & Intel), and Linux (x86_64 & ARM64 `.deb`, `.rpm`, `.AppImage`).
* 🎨 **3 Color Palettes**: Exact 1:1 ports of original `SoX` (default), `Spectrum`, and `Mono` palettes.
* 📐 **Lossless Resolution Exports**: Export at current window size, presets (1080p, 4K, etc.), or exact **Original (samples × bands)** for 1:1 lossless FFT frequency mapping.
* 🌐 **34 Languages**: Full internationalization catalogs ported from original Spek.

---

## Parity Matrix

| Original Component (`src/*.cc`) | This Reimplementation | Status |
|---|---|---|
| `spek-audio.cc` — FFmpeg decoding, streams, metadata, duration, error handling | `src-tauri/src/audio.rs` — Pure-Rust **symphonia** (built-in) + **streaming ffmpeg** pipe fallback | ✅ 100% |
| `spek-fft.cc` — `av_rdft` RDFT + magnitude `10*log10(re²+im²/n²)` | `src-tauri/src/fft.rs` — `realfft` + exact reference formula, verified vs `av_rdft` | ✅ 100% |
| `spek-palette.cc` — SoX / Spectrum / Mono palettes | `src-tauri/src/palette.rs` + `src/palette.ts` — Bit-identical mathematical formulas | ✅ 100% |
| `spek-pipeline.cc` — Interval arithmetic, Hann/Hamming/Blackman-Harris windows | `src-tauri/src/pipeline.rs` — Multi-threaded Rayon pipeline with exact interval bounds | ✅ 100% |
| `spek-spectrogram.cc` — Canvas spectrogram, rulers, padding (`LPAD=60`, `TPAD=60`, `RPAD=90`, `BPAD=40`) | `src/main.ts` + `src/renderer.ts` — HTML5 Canvas, HiDPI support, dynamic tick rulers | ✅ 100% |
| `spek-window.cc` — Menu bar, toolbar, drag-and-drop, update check, file dialogs | `index.html` + `src/main.ts` — Dark theme UI, native dialogs, drag-and-drop overlay | ✅ 100% |
| `spek-preferences.cc` — Preferences persistence (`~/.config/spek/preferences`) | `src-tauri/src/preferences.rs` — XDG config persistence, preferences dialog | ✅ 100% |
| `spek-utils.cc` — `spek_vercmp` version comparison | `src-tauri/src/utils.rs` — Exact port using `strtol` semantics | ✅ 100% |

---

## Keyboard Shortcuts & Mouse Controls

| Shortcut | Action |
|---|---|
| `Ctrl/⌘ + O` / `Ctrl/⌘ + N` | Open audio file |
| `Ctrl/⌘ + S` | Save spectrogram image |
| `Ctrl/⌘ + ,` | Open Preferences |
| `Ctrl/⌘ + W` / `Ctrl/⌘ + Q` | Close window |
| `c` / `Shift + C` | Cycle Next / Prev audio channel |
| `s` / `Shift + S` | Cycle Next / Prev audio stream |
| `f` / `Shift + F` | Cycle Next / Prev window function (Hann → Hamming → Blackman-Harris) |
| `w` / `Shift + W` | Step DFT size up / down (256 to 16,384, default 2,048) |
| `p` / `Shift + P` | Cycle color palette (SoX → Spectrum → Mono) |
| `l` / `Shift + L` | Lower dynamic range threshold $\pm 1\text{ dB}$ |
| `u` / `Shift + U` | Upper dynamic range threshold $\pm 1\text{ dB}$ |
| `r` / **Middle Click** | Reset dynamic range to defaults ($-120\text{ dB}$ to $0\text{ dB}$) |
| **Mouse Wheel** | Adjust Lower dB range (scroll up = raise, scroll down = lower) |
| **Shift + Mouse Wheel** | Adjust Upper dB range |

---

## Build & Development

### Prerequisites
* Rust `1.77+`
* Node.js `20+` and `npm`
* Linux: `libwebkit2gtk-4.1-dev` `libappindicator3-dev` `librsvg2-dev` `patchelf` `libasound2-dev`

### Commands

```bash
# Install frontend dependencies
npm install

# Run in development mode (hot-reload)
npm run tauri dev

# Run test suite
cargo test --manifest-path src-tauri/Cargo.toml --lib

# Build release binaries & bundles
npm run build
npm run tauri build
```

---

## Artwork & Credits

* **Spek Original Author**: Alexander Kojevnikov & contributors.
* **Artwork**: 
  * Original Spek logo artwork by **Olga Vasylevska**.
  * Ferris the Crab artwork by **Karen Rustad Tölva** ([rustacean.net](https://www.rustacean.net), Public Domain).
  * Spektaurs icon design: blended tribute.
* **Palettes**: Rob Sykes (SoX palette), Dan Bruton (Dan Bruton's astronomical spectrum algorithm).

---

## License

GPL-3.0 (same as original Spek). See `LICENSE`.
