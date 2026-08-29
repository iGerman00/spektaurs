# Spektaurs
> A Rust + Tauri Reimplementation of [Spek](https://www.spek.cc)

<div align="center">

![Spektaurs Logo](https://raw.githubusercontent.com/iGerman00/spektaurs/main/src-tauri/icons/128x128.png)


<!-- badges -->
[![CI](https://github.com/iGerman00/spektaurs/actions/workflows/ci.yml/badge.svg)](https://github.com/iGerman00/spektaurs/actions/workflows/ci.yml)
[![Release](https://github.com/iGerman00/spektaurs/actions/workflows/release.yml/badge.svg)](https://github.com/iGerman00/spektaurs/actions/workflows/release.yml)
[![Latest Release](https://img.shields.io/github/v/release/iGerman00/spektaurs?logo=github&color=blue)](https://github.com/iGerman00/spektaurs/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/iGerman00/spektaurs/latest/total?logo=github&color=2ea44f)](https://github.com/iGerman00/spektaurs/releases/latest)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-22272e?logo=apple&logoColor=white)](https://github.com/iGerman00/spektaurs/releases/latest)
[![Rust](https://img.shields.io/badge/Rust-1.77+-dea584?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Tauri 2](https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://github.com/iGerman00/spektaurs/blob/main/LICENSE)

</div>

Spektaurs helps you analyse audio files by displaying their spectrogram.

This just about replicates the core original features of Spek while delivering a blazing-fast, modern cross-platform desktop application powered by [Tauri 2](https://tauri.app/), Rust backend, and TypeScript / HTML5 Canvas.

Based on: [alexkay/spek](https://github.com/alexkay/spek) - `v0.8.5`, GPL-3.0.

<div align="center">

![Spektaurs Demo Screenshot](https://github.com/user-attachments/assets/75eb00fd-4172-4298-984b-404f8901c12f)

</div>

## Differences from Spek
* Rust and Tauri 2 over C++
* Vanilla TypeScript + HTML5 Canvas over wxWidgets GUI
* Some extra creature comforts like improved keyboard shortcuts, mouse controls
* Convenient default configurations for various analysis options
* Cross-platform and thanks to cargo + Tauri, way easier to build - [Releases](https://github.com/iGerman00/spektaurs/releases/latest) for Windows, macOS, and Linux are up.
* Basic additional image export settings
* Added language new language lines for new UI elements

## Parity
> This is straight from AI, trust at your discretion.

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

## Build / Development

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

## Artwork / Credits

* **Spek Original Author**: Alexander Kojevnikov & contributors.
* **Artwork**: 
  * Original Spek logo artwork by **Olga Vasylevska**.
  * Ferris the Crab artwork by **Karen Rustad Tölva** ([rustacean.net](https://www.rustacean.net), Public Domain).
  * Spektaurs icon design: 5 minutes in Photopea by iGerman00.
* **Palettes**: Rob Sykes (SoX palette), Dan Bruton (Dan Bruton's astronomical spectrum algorithm).

## License

GPL-3.0 (same as original Spek). See `LICENSE`.

## AI Disclosure

This project is mostly AI-written.

It's a simple tool, it works. I mostly did this because Spek is somewhat abandoned and macOS is removing support for Intel apps very soon.
