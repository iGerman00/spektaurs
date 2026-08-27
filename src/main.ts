import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

// ----- Types -----
type Palette = "spectrum" | "sox" | "mono";
type WindowFn = "hann" | "hamming" | "blackman-harris";

interface SpectrogramResult {
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

interface ProgressPayload {
  sample: number;
  bands: number;
  values: number[];
}

// ----- i18n (minimal, extensible) -----
const translations: Record<string, Record<string, string>> = {
  en: {
    "File": "File", "Edit": "Edit", "Help": "Help",
    "Open…": "Open…", "Save Spectrogram…": "Save Spectrogram…", "Exit": "Exit",
    "Preferences…": "Preferences…", "Help (F1)": "Help (F1)", "About… (Shift+F1)": "About… (Shift+F1)",
    "Open": "Open", "Save": "Save",
    "A new version of Spek is available, click to download.": "A new version of Spek is available, click to download.",
    "Drop an audio file here or use File → Open": "Drop an audio file here or use File → Open",
    "Analysing…": "Analysing…",
    "Preferences": "Preferences", "General": "General", "Language:": "Language:", "Check for updates": "Check for updates", "OK": "OK", "Close": "Close",
    "About Spek": "About Spek", "Acoustic Spectrum Analyser": "Acoustic Spectrum Analyser", "Spek Website": "Spek Website", "Developers": "Developers", "Artist": "Artist", "Translators": "Translators", "License: GPL-2.0": "License: GPL-2.0",
  },
  de: {
    "File": "Datei", "Edit": "Bearbeiten", "Help": "Hilfe",
    "Open…": "Öffnen…", "Save Spectrogram…": "Spektrogramm speichern…", "Exit": "Beenden",
    "Preferences…": "Einstellungen…", "Help (F1)": "Hilfe (F1)", "About… (Shift+F1)": "Über… (Shift+F1)",
    "Open": "Öffnen", "Save": "Speichern",
    "A new version of Spek is available, click to download.": "Eine neue Version von Spek ist verfügbar, klicken zum Herunterladen.",
    "Drop an audio file here or use File → Open": "Audiodatei hier ablegen oder Datei → Öffnen",
    "Analysing…": "Analysiere…",
    "Preferences": "Einstellungen", "General": "Allgemein", "Language:": "Sprache:", "Check for updates": "Auf Updates prüfen", "OK": "OK", "Close": "Schließen",
    "About Spek": "Über Spek", "Acoustic Spectrum Analyser": "Akustischer Spektrumanalysator", "Spek Website": "Spek-Webseite",
  },
  fr: {
    "File": "Fichier", "Edit": "Édition", "Help": "Aide",
    "Open…": "Ouvrir…", "Save Spectrogram…": "Enregistrer le spectrogramme…", "Exit": "Quitter",
    "Preferences…": "Préférences…", "Help (F1)": "Aide (F1)", "About… (Shift+F1)": "À propos… (Shift+F1)",
    "Open": "Ouvrir", "Save": "Enregistrer",
  },
  ja: {
    "File": "ファイル", "Edit": "編集", "Help": "ヘルプ",
    "Open…": "開く…", "Save Spectrogram…": "スペクトログラムを保存…", "Exit": "終了",
  },
};

let currentLang = "en";
function t(key: string): string {
  const dict = translations[currentLang] || translations.en;
  return dict[key] || translations.en[key] || key;
}
function applyI18n() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach(el => {
    const k = el.getAttribute("data-i18n")!;
    el.textContent = t(k);
  });
  // Update menu titles that are not data-i18n but text
  // For simplicity, just re-render if needed
}

// ----- Constants -----
const MIN_RANGE = -140;
const MAX_RANGE = 0;
const URANGE_DEFAULT = 0;
const LRANGE_DEFAULT = -120;
const FFT_BITS_DEFAULT = 11;
const MIN_FFT_BITS = 8;
const MAX_FFT_BITS = 14;
const LPAD = 60;
const TPAD = 60;
const RPAD = 90;
const BPAD = 40;
const GAP = 10;
const RULER = 10;
const PACKAGE_NAME = "Spek";
const PACKAGE_VERSION = "0.8.5";

// ----- State -----
let state = {
  path: "" as string,
  desc: "" as string,
  duration: 0,
  sampleRate: 0,
  streams: 0,
  stream: 0,
  channels: 0,
  channel: 0,
  windowFunction: "hann" as WindowFn,
  fftBits: FFT_BITS_DEFAULT,
  palette: "sox" as Palette,
  urange: URANGE_DEFAULT,
  lrange: LRANGE_DEFAULT,
  magnitudes: [] as number[],
  bands: 0,
  samples: 0,
  error: "" as string,
};

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D | null;
let container: HTMLElement;
let loadingEl: HTMLElement;
let infoBar: HTMLElement;
let toastEl: HTMLElement;
let generation = 0;
let lastSamples = -1;
let cachedResult: SpectrogramResult | null = null;
let cachedKey = "";
let offscreen: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

// ----- Palette -----
function spectrum(level: number): number {
  level *= 0.6625;
  let r = 0, g = 0, b = 0;
  if (level >= 0 && level < 0.15) { r = (0.15 - level) / (0.15 + 0.075); g = 0; b = 1; }
  else if (level >= 0.15 && level < 0.275) { r = 0; g = (level - 0.15) / (0.275 - 0.15); b = 1; }
  else if (level >= 0.275 && level < 0.325) { r = 0; g = 1; b = (0.325 - level) / (0.325 - 0.275); }
  else if (level >= 0.325 && level < 0.5) { r = (level - 0.325) / (0.5 - 0.325); g = 1; b = 0; }
  else if (level >= 0.5 && level < 0.6625) { r = 1; g = (0.6625 - level) / (0.6625 - 0.5); b = 0; }
  let cf = 1; if (level >= 0 && level < 0.1) cf = level / 0.1; cf *= 255;
  const rr = Math.floor(r * cf + 0.5); const gg = Math.floor(g * cf + 0.5); const bb = Math.floor(b * cf + 0.5);
  return (rr << 16) + (gg << 8) + bb;
}
function sox(level: number): number {
  let r = 0; if (level >= 0.13 && level < 0.73) r = Math.sin((level - 0.13) / 0.60 * Math.PI / 2); else if (level >= 0.73) r = 1;
  let g = 0; if (level >= 0.6 && level < 0.91) g = Math.sin((level - 0.6) / 0.31 * Math.PI / 2); else if (level >= 0.91) g = 1;
  let b = 0; if (level < 0.60) b = 0.5 * Math.sin(level / 0.6 * Math.PI); else if (level >= 0.78) b = (level - 0.78) / 0.22;
  const rr = Math.floor(r * 255 + 0.5); const gg = Math.floor(g * 255 + 0.5); const bb = Math.floor(b * 255 + 0.5);
  return (rr << 16) + (gg << 8) + bb;
}
function mono(level: number): number { const v = Math.floor(level * 255 + 0.5); return (v << 16) + (v << 8) + v; }
function paletteColor(palette: Palette, level: number): number {
  switch (palette) { case "spectrum": return spectrum(level); case "sox": return sox(level); case "mono": return mono(level); }
}
const paletteLUT = new Map<string, Uint32Array>();
function getPaletteLUT(palette: Palette): Uint32Array {
  const key = palette;
  if (paletteLUT.has(key)) return paletteLUT.get(key)!;
  const lut = new Uint32Array(256);
  for (let i=0;i<256;i++) {
    const level = i/255;
    lut[i] = paletteColor(palette, level);
  }
  paletteLUT.set(key, lut);
  return lut;
}
function paletteColorFast(palette: Palette, level: number): number {
  const lut = getPaletteLUT(palette);
  const idx = Math.max(0, Math.min(255, Math.floor(level*255)));
  return lut[idx];
}
function bitsToBands(bits: number): number { return (1 << (bits - 1)) + 1; }
function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }
function timeFormatter(unit: number): string { const m = Math.floor(unit / 60); const s = unit % 60; return `${m}:${s.toString().padStart(2, "0")}`; }
function freqFormatter(unit: number): string { return `${unit / 1000} kHz`; }
function densityFormatter(unit: number): string { return `${-unit} dB`; }
function trimText(ctx: CanvasRenderingContext2D, s: string, length: number, trimEnd: boolean): string {
  if (length <= 0) return ""; if (ctx.measureText(s).width <= length) return s;
  const fix = "..."; let i = 0, k = s.length;
  while (k - i > 1) { const j = Math.floor((i + k) / 2); const cand = trimEnd ? s.substring(0, j) + fix : fix + s.substring(j); const ww = ctx.measureText(cand).width; if (trimEnd !== (ww > length)) i = j; else k = j; }
  return trimEnd ? s.substring(0, i) + fix : fix + s.substring(k);
}
class Ruler {
  constructor(public x: number, public y: number, public pos: "top" | "right" | "bottom" | "left", public sampleLabel: string, public factors: number[], public minUnits: number, public maxUnits: number, public spacing: number, public scale: number, public offset: number, public formatter: (u: number) => string) {}
  draw(ctx: CanvasRenderingContext2D) {
    const size = ctx.measureText(this.sampleLabel); const len = (this.pos === "top" || this.pos === "bottom") ? size.width : 12;
    let factor = 0; for (const f of this.factors) { if (f === 0) break; if (Math.abs(this.scale * f) >= this.spacing * len) { factor = f; break; } }
    this.drawTick(ctx, this.minUnits); this.drawTick(ctx, this.maxUnits);
    if (factor > 0) { for (let tick = this.minUnits + factor; tick < this.maxUnits; tick += factor) { if (Math.abs(this.scale * (this.maxUnits - tick)) < len * 1.2) break; this.drawTick(ctx, tick); } }
  }
  drawTick(ctx: CanvasRenderingContext2D, tick: number) {
    const GAP = 10, TICK_LEN = 4; const label = this.formatter(tick);
    const value = (this.pos === "top" || this.pos === "bottom") ? tick : this.maxUnits + this.minUnits - tick;
    const p = this.offset + this.scale * (value - this.minUnits); const w = ctx.measureText(label).width; const h = 12;
    // Use top baseline for consistency
    const prevBaseline = ctx.textBaseline; ctx.textBaseline = "middle";
    if (this.pos === "top") ctx.fillText(label, this.x + p - w / 2, this.y - GAP - h/2);
    else if (this.pos === "right") ctx.fillText(label, this.x + GAP, this.y + p);
    else if (this.pos === "bottom") ctx.fillText(label, this.x + p - w / 2, this.y + GAP + h/2);
    else if (this.pos === "left") ctx.fillText(label, this.x - w - GAP, this.y + p);
    ctx.textBaseline = prevBaseline;
    ctx.beginPath();
    if (this.pos === "top") { ctx.moveTo(this.x + p, this.y); ctx.lineTo(this.x + p, this.y - TICK_LEN); }
    else if (this.pos === "right") { ctx.moveTo(this.x, this.y + p); ctx.lineTo(this.x + TICK_LEN, this.y + p); }
    else if (this.pos === "bottom") { ctx.moveTo(this.x + p, this.y); ctx.lineTo(this.x + p, this.y + TICK_LEN); }
    else if (this.pos === "left") { ctx.moveTo(this.x, this.y + p); ctx.lineTo(this.x - TICK_LEN, this.y + p); }
    ctx.stroke();
  }
}

function ensureOffscreen(samples: number, bands: number) {
  // For huge offscreens (large window + large screen) keep full size but ensure we don't OOM — cap at 8M pixels
  // If samples*bands > 12M, we still create full offscreen but fill is single rect, cheap
  if (offscreen && offscreen.width === samples && offscreen.height === bands) return;
  offscreen = document.createElement("canvas");
  offscreen.width = samples;
  offscreen.height = bands;
  offscreenCtx = offscreen.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
  if (offscreenCtx) {
    offscreenCtx.fillStyle = "black";
    offscreenCtx.fillRect(0, 0, samples, bands);
  }
}
function updateOffscreenColumn(sample: number, bands: number, values: number[]) {
  if (!offscreen || !offscreenCtx || offscreen.width !== state.samples || offscreen.height !== bands) {
    ensureOffscreen(state.samples, bands);
  }
  if (!offscreenCtx || !offscreen) return;
  const range = state.urange - state.lrange;
  // Use ImageData for the column — one putImageData per column instead of bands fillRect (much faster, continuous)
  const colData = offscreenCtx.createImageData(1, bands);
  for (let y = 0; y < bands; y++) {
    const v = values[y];
    const clamped = clamp(v, state.lrange, state.urange);
    const level = range === 0 ? 0 : (clamped - state.lrange) / range;
    const col = paletteColorFast(state.palette, level);
    const yy = bands - y - 1;
    const idx = yy * 4;
    colData.data[idx] = (col >> 16) & 0xFF;
    colData.data[idx+1] = (col >> 8) & 0xFF;
    colData.data[idx+2] = col & 0xFF;
    colData.data[idx+3] = 255;
  }
  offscreenCtx.putImageData(colData, sample, 0);
}
function rebuildOffscreenFromState() {
  if (state.samples <= 0 || state.bands <= 0 || state.magnitudes.length === 0) {
    offscreen = null; offscreenCtx = null; return;
  }
  ensureOffscreen(state.samples, state.bands);
  if (!offscreenCtx || !offscreen) return;
  const range = state.urange - state.lrange;
  const bands = state.bands, samples = state.samples;
  const imgData = offscreenCtx.createImageData(samples, bands);
  for (let x = 0; x < samples; x++) {
    const base = x * bands;
    for (let y = 0; y < bands; y++) {
      const v = state.magnitudes[base + y];
      const isNan = !isFinite(v);
      const clamped = isNan ? state.lrange : clamp(v, state.lrange, state.urange);
      const level = isNan ? 0 : (range === 0 ? 0 : (clamped - state.lrange) / range);
      const col = paletteColorFast(state.palette, level);
      const yy = bands - y - 1;
      const idx = (yy * samples + x) * 4;
      imgData.data[idx] = (col >> 16) & 0xFF;
      imgData.data[idx+1] = (col >> 8) & 0xFF;
      imgData.data[idx+2] = col & 0xFF;
      imgData.data[idx+3] = 255;
    }
  }
  offscreenCtx.putImageData(imgData, 0, 0);
}

function render() {
  if (!ctx || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const width = Math.max(0, rect.width);
  const height = Math.max(0, rect.height);
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = width + "px"; canvas.style.height = height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = width, h = height;
  ctx.fillStyle = "black"; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "white"; ctx.fillStyle = "white"; ctx.lineWidth = 1;

  // Larger, more readable fonts — scaled for DPI
  const fontScale = window.devicePixelRatio > 1 ? 1.1 : 1.0;
  const normalFont = `${Math.round(12 * fontScale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const largeFont = `600 ${Math.round(14 * fontScale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const smallFont = `${Math.round(11 * fontScale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const normalHeight = 14, largeHeight = 16;
  // smallHeight not needed as version shares baseline with package (fixed misalignment)

  // --- Top bar: use alphabetic baseline, shared y for Spek + version (fixes misalignment) ---
  ctx.textBaseline = "alphabetic";
  ctx.font = largeFont; ctx.fillStyle = "white";
  const pkgY = TPAD - GAP - 6; // baseline
  const pkgX = w - RPAD + GAP;
  ctx.fillText(PACKAGE_NAME, pkgX, pkgY);
  const pkgW = ctx.measureText(PACKAGE_NAME + " ").width;
  ctx.font = smallFont; ctx.fillStyle = "#ccc";
  ctx.fillText(PACKAGE_VERSION, pkgX + pkgW, pkgY); // same baseline, now aligned

  const hasImage = state.samples > 0 && state.bands > 1 && state.magnitudes.length > 0 && w - LPAD - RPAD > 0 && h - TPAD - BPAD > 0;
  if (hasImage) {
    const imgW = w - LPAD - RPAD, imgH = h - TPAD - BPAD;
    const totalPixels = state.samples * state.bands;
    const isPreview = state.magnitudes.some(v => !isFinite(v));
    if (totalPixels > 8_000_000) {
      // Large: direct display rendering — for preview use fast nearest (400k), for final use averaging
      const displayW = imgW, displayH = imgH;
      const xRatio = state.samples / displayW;
      const yRatio = state.bands / displayH;
      const range = state.urange - state.lrange;
      const lut = getPaletteLUT(state.palette);
      const imgData = ctx.createImageData(displayW, displayH);
      if (isPreview) {
        // Fast nearest neighbor for preview (smooth, not chopped, ~400k ops)
        for (let dy = 0; dy < displayH; dy++) {
          const srcY = Math.min(state.bands - 1, Math.floor(dy * yRatio));
          for (let dx = 0; dx < displayW; dx++) {
            const srcX = Math.min(state.samples - 1, Math.floor(dx * xRatio));
            const v = state.magnitudes[srcX * state.bands + srcY];
            const clamped = isFinite(v) ? clamp(v, state.lrange, state.urange) : state.lrange;
            const level = range === 0 ? 0 : (clamped - state.lrange) / range;
            const col = lut[Math.max(0, Math.min(255, Math.floor(level*255)))];
            const idx = (dy * displayW + dx) * 4;
            imgData.data[idx] = (col >> 16) & 0xFF;
            imgData.data[idx+1] = (col >> 8) & 0xFF;
            imgData.data[idx+2] = col & 0xFF;
            imgData.data[idx+3] = 255;
          }
        }
      } else {
        // Final: high-quality averaging for W>8192 detail (more detailed, not less)
        for (let dx = 0; dx < displayW; dx++) {
          const srcX0 = Math.floor(dx * xRatio);
          const srcX1 = Math.min(state.samples, Math.floor((dx + 1) * xRatio));
          if (srcX1 <= srcX0) continue;
          for (let dy = 0; dy < displayH; dy++) {
            const srcY0 = Math.floor(dy * yRatio);
            const srcY1 = Math.min(state.bands, Math.floor((dy + 1) * yRatio));
            let sum = 0, cnt = 0;
            for (let sx = srcX0; sx < srcX1; sx++) {
              const base = sx * state.bands;
              for (let sy = srcY0; sy < srcY1; sy++) {
                const v = state.magnitudes[base + sy];
                if (isFinite(v)) { sum += clamp(v, state.lrange, state.urange); cnt++; }
              }
            }
            const avg = cnt ? sum / cnt : state.lrange;
            const level = range === 0 ? 0 : (avg - state.lrange) / range;
            const col = lut[Math.max(0, Math.min(255, Math.floor(level*255)))];
            const idx = (dy * displayW + dx) * 4;
            imgData.data[idx] = (col >> 16) & 0xFF;
            imgData.data[idx+1] = (col >> 8) & 0xFF;
            imgData.data[idx+2] = col & 0xFF;
            imgData.data[idx+3] = 255;
          }
        }
      }
      ctx.putImageData(imgData, LPAD, TPAD);
    } else {
      // Use persistent offscreen for incremental, smooth animation
      if (!offscreen || offscreen.width !== state.samples || offscreen.height !== state.bands) {
        rebuildOffscreenFromState();
      }
      if (offscreen) {
        ctx.imageSmoothingEnabled = false; // crisp for normal, keeps W>8192 detailed
        ctx.drawImage(offscreen, LPAD, TPAD, imgW, imgH);
      }
    }
    // File name + desc (use top baseline for these) + tooltip for ellipsed text
    ctx.textBaseline = "top"; ctx.font = largeFont; ctx.fillStyle = "white";
    const displayName = state.path ? (state.path.split(/[\/]/).pop() || state.path) : "";
    const trimmedName = trimText(ctx, displayName, w - LPAD - RPAD, false);
    ctx.fillText(trimmedName, LPAD, TPAD - 2*GAP - normalHeight - largeHeight);
    ctx.font = normalFont;
    const trimmedDesc = trimText(ctx, state.desc, w - LPAD - RPAD, true);
    ctx.fillText(trimmedDesc, LPAD, TPAD - GAP - normalHeight);
    // Tooltip when ellipsed (fixes small window truncated stream 1/1 text)
    if (trimmedName !== displayName || trimmedDesc !== state.desc) {
      container.title = `${displayName}
${state.desc}`;
    } else {
      container.title = "";
    }
    ctx.textBaseline = "alphabetic";
    ctx.font = smallFont; ctx.fillStyle = "white"; ctx.strokeStyle = "white";
    if (state.duration) {
      const timeFactors = [1,2,5,10,20,30,60,120,300,600,1200,1800,0];
      new Ruler(LPAD, h - BPAD, "bottom", "00:00", timeFactors, 0, Math.floor(state.duration), 1.5, (w - LPAD - RPAD)/state.duration, 0, timeFormatter).draw(ctx);
    }
    if (state.sampleRate) {
      const freq = Math.floor(state.sampleRate/2);
      const freqFactors = [1000,2000,5000,10000,20000,0];
      new Ruler(LPAD, TPAD, "left", "00 kHz", freqFactors, 0, freq, 3.0, (h - TPAD - BPAD)/freq, 0, freqFormatter).draw(ctx);
    }
  }
  ctx.textBaseline = "top";
  ctx.strokeStyle = "white"; ctx.strokeRect(LPAD, TPAD, w - LPAD - RPAD, h - TPAD - BPAD);
  if (h - TPAD - BPAD > 0) {
    const paletteBands = bitsToBands(state.fftBits);
    const pOff = document.createElement("canvas"); pOff.width = RULER; pOff.height = paletteBands;
    const poctx = pOff.getContext("2d");
    if (poctx) {
      const d = poctx.createImageData(RULER, paletteBands);
      for (let y = 0; y < paletteBands; y++) {
        const col = paletteColor(state.palette, y / paletteBands);
        const r = (col>>16)&0xFF, g=(col>>8)&0xFF, b=col&0xFF;
        const yy = paletteBands - y - 1;
        for (let x=0;x<RULER;x++) { const idx=(yy*RULER+x)*4; d.data[idx]=r; d.data[idx+1]=g; d.data[idx+2]=b; d.data[idx+3]=255; }
      }
      poctx.putImageData(d,0,0);
      ctx.drawImage(pOff, w - RPAD + GAP, TPAD, RULER, h - TPAD - BPAD + 1);
    }
    ctx.textBaseline = "middle"; ctx.font = smallFont; ctx.fillStyle = "white"; ctx.strokeStyle = "white";
    const densityFactors = [1,2,5,10,20,50,0];
    new Ruler(w - RPAD + GAP + RULER, TPAD, "right", "-00 dB", densityFactors, -state.urange, -state.lrange, 3.0, (h - TPAD - BPAD)/(state.lrange - state.urange), h - TPAD - BPAD, densityFormatter).draw(ctx);
    ctx.textBaseline = "alphabetic";
  }
  if (state.error) {
    ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.font = largeFont; ctx.fillStyle = "#ff6666";
    ctx.fillText(state.error, w/2, h/2); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  } else if (!state.path) {
    ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.font = normalFont; ctx.fillStyle = "#888";
    ctx.fillText(t("Drop an audio file here or use File → Open"), w/2, h/2); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }
}

// ----- Actions -----
async function analyzeCurrent() {
  if (!state.path) return;
  const myGen = ++generation;
  const rect = container.getBoundingClientRect();
  const availW = Math.max(1, Math.floor(rect.width - LPAD - RPAD));
  const samples = availW;
  // Cache check: if same file+params+samples, reuse
  const key = `${state.path}|${state.stream}|${state.channel}|${state.windowFunction}|${state.fftBits}|${samples}|${state.urange}|${state.lrange}|${state.palette}`;
  // Note: palette/urange/lrange don't require re-analysis, only re-render. So cache without them for pipeline,
  // but we include them for simplicity to avoid stale magnitudes.
  // For palette/range changes we actually don't need pipeline — just re-render. Caller should handle.
  // Here we are called for pipeline-changing params, so include those.
  if (cachedKey === key && cachedResult && lastSamples === samples) {
    Object.assign(state, { bands: cachedResult.bands, samples: cachedResult.samples, sampleRate: cachedResult.sample_rate, duration: cachedResult.duration, desc: cachedResult.desc, magnitudes: cachedResult.magnitudes.slice(), streams: cachedResult.streams, channels: cachedResult.channels, error: cachedResult.error });
    document.title = state.path ? `Spek - ${state.path.split(/[\\/]/).pop()}` : "Spek - Acoustic Spectrum Analyser";
    rebuildOffscreenFromState();
    render();
    return;
  }

  // Prepare progressive state — incremental offscreen for smooth continuous lines
  const bands = bitsToBands(state.fftBits);
  state.bands = bands; state.samples = samples;
  state.magnitudes = new Array(samples * bands).fill(NaN);
  state.error = "";
  ensureOffscreen(samples, bands);
  if (offscreenCtx && offscreen) {
    offscreenCtx.fillStyle = "black";
    offscreenCtx.fillRect(0, 0, samples, bands);
  }
  render();
  loadingEl.classList.remove("hidden");
  const loadingText = loadingEl.querySelector("span");
  if (loadingText) loadingText.textContent = `${t("Analysing…")} 0%`;
  let showPreview = true;
  try { const pref:any = await invoke("get_default_settings"); showPreview = pref.show_preview !== false; } catch {}
  let lastRender = performance.now();
  let unlisten: (() => void) | null = null;
  if (showPreview) {
    try {
      unlisten = await listen<ProgressPayload>("spectrogram-progress", (ev) => {
        if (myGen !== generation) return;
        const p = ev.payload;
        if (p.bands !== bands) return;
        const off = p.sample * bands;
        for (let i = 0; i < bands && off + i < state.magnitudes.length; i++) state.magnitudes[off + i] = p.values[i];
        updateOffscreenColumn(p.sample, bands, p.values);
        const now = performance.now();
        if (now - lastRender > 16 || p.sample + 1 === samples) {
          lastRender = now;
          requestAnimationFrame(() => { if (myGen === generation) render(); });
          if (loadingText) loadingText.textContent = `${t("Analysing…")} ${Math.round((p.sample + 1) / samples * 100)}%`;
        }
      });
    } catch {}
  }

  try {
    const result: SpectrogramResult = await invoke("analyze_audio", { params: { path: state.path, stream: state.stream, channel: state.channel, window_function: state.windowFunction, fft_bits: state.fftBits, samples } });
    if (myGen !== generation) {
      if (unlisten) unlisten();
      return; // cancelled by newer generation
    }
    state.bands = result.bands; state.samples = result.samples; state.sampleRate = result.sample_rate; state.duration = result.duration;
    state.desc = result.desc; state.magnitudes = result.magnitudes.slice(); state.streams = result.streams; state.channels = result.channels; state.error = result.error;
    document.title = state.path ? `Spek - ${state.path.split(/[\/]/).pop()}` : "Spek - Acoustic Spectrum Analyser";
    // Cache
    cachedResult = result; cachedKey = key; lastSamples = samples;
    if (!showPreview) {
      rebuildOffscreenFromState();
    } else if (!offscreen || offscreen.width !== state.samples || offscreen.height !== state.bands) {
      rebuildOffscreenFromState();
    }
  } catch (e:any) {
    if (myGen === generation) { state.error = String(e); showToast("Error: "+state.error); }
  } finally {
    if (unlisten) unlisten();
    if (myGen === generation) { loadingEl.classList.add("hidden"); render(); }
  }
}

async function openFileDialog() {
  const selected = await dialogOpen({ title: t("Open…"), filters: [{ name: "Audio files", extensions: ["3gp","aac","aif","aifc","aiff","amr","awb","ape","au","dts","flac","flv","gsm","m4a","m4p","mp3","mp4","mp+","mpc","mpp","oga","ogg","opus","ra","ram","snd","wav","wma","wv"] }, { name: "All files", extensions: ["*"] }] });
  if (typeof selected === "string" && selected) { state.path = selected; state.stream=0; state.channel=0; cachedKey=""; await analyzeCurrent(); }
}
async function saveSpectrogram() {
  if (!canvas || state.samples===0) { showToast("No spectrogram to save"); return; }
  const selected = await dialogSave({ title: t("Save Spectrogram…"), defaultPath: (state.path ? state.path.split(/[\\/]/).pop()+".png" : "Untitled.png"), filters: [{ name: "PNG images", extensions: ["png"] }] });
  if (!selected) return;
  // Respect save_resolution preference
  let dataUrl: string;
  try {
    const prefs:any = await invoke("get_default_settings");
    const res = prefs.save_resolution || "window";
    if (res === "window" || res === "original" || res.includes("x")) {
      if (res === "window") {
        dataUrl = canvas.toDataURL("image/png");
      } else if (res === "original" && offscreen) {
        dataUrl = offscreen.toDataURL("image/png");
      } else if (res.includes("x")) {
        const [wStr, hStr] = res.split("x");
        const w = parseInt(wStr), h = parseInt(hStr);
        const tmp = document.createElement("canvas"); tmp.width = w; tmp.height = h;
        const tctx = tmp.getContext("2d");
        if (tctx && offscreen) {
          tctx.fillStyle = "black"; tctx.fillRect(0,0,w,h);
          // Draw offscreen scaled to requested resolution
          tctx.drawImage(offscreen, 0, 0, w, h);
          // For simplicity, not re-rendering rulers at new res — use window render scaled
          // Better would be to re-render at that res, but this is a quick export
          dataUrl = tmp.toDataURL("image/png");
        } else {
          dataUrl = canvas.toDataURL("image/png");
        }
      } else {
        dataUrl = canvas.toDataURL("image/png");
      }
    } else {
      dataUrl = canvas.toDataURL("image/png");
    }
  } catch {
    dataUrl = canvas.toDataURL("image/png");
  }
  const base64 = dataUrl.split(",")[1]; const bytes = Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  try { // @ts-ignore
    await writeFile(selected, bytes); showToast("Saved to "+selected);
  } catch { const a=document.createElement("a"); a.href=dataUrl; a.download=selected.split(/[\\/]/).pop()||"spectrogram.png"; document.body.appendChild(a); a.click(); a.remove(); showToast("Saved (download)"); }
}
function showToast(msg:string){ toastEl.textContent=msg; toastEl.classList.remove("hidden"); setTimeout(()=>toastEl.classList.add("hidden"),3000); }
async function openPreferences() {
  const dlg=document.getElementById("prefs-dialog") as HTMLDialogElement;
  const langSelect=document.getElementById("language-select") as HTMLSelectElement;
  const checkUpdate=document.getElementById("check-update") as HTMLInputElement;
  const showPreview=document.getElementById("show-preview") as HTMLInputElement;
  const prefWindow=document.getElementById("pref-window") as HTMLSelectElement;
  const prefDft=document.getElementById("pref-dft") as HTMLSelectElement;
  const prefPalette=document.getElementById("pref-palette") as HTMLSelectElement;
  const prefLow=document.getElementById("pref-low") as HTMLInputElement;
  const prefHigh=document.getElementById("pref-high") as HTMLInputElement;
  const prefSaveRes=document.getElementById("pref-save-res") as HTMLSelectElement;
  langSelect.innerHTML=""; const langs:[string,string][]=await invoke("get_available_languages");
  const curLang:string=await invoke("get_language"); const checkVal:boolean=await invoke("get_check_update");
  const defaults:any = await invoke("get_default_settings");
  checkUpdate.checked=checkVal; (showPreview as any).checked = defaults.show_preview;
  prefWindow.value = defaults.window_function; prefDft.value = String(defaults.fft_bits);
  prefPalette.value = defaults.palette; prefLow.value = String(defaults.lrange); prefHigh.value = String(defaults.urange);
  prefSaveRes.value = defaults.save_resolution;
  currentLang=curLang || "en"; applyI18n();
  langs.forEach(([code,name])=>{ const opt=document.createElement("option"); opt.value=code; opt.textContent=name||t("(system default)"); if(code===curLang) opt.selected=true; langSelect.appendChild(opt); });
  if(!Array.from(langSelect.options).some(o=>o.selected) && langSelect.options.length) langSelect.selectedIndex=0;
  dlg.showModal();
  const handler=async()=>{
    const sel=langSelect.value;
    await invoke("set_language",{value:sel});
    await invoke("set_check_update",{value:checkUpdate.checked});
    await invoke("set_default_settings",{settings:{
      window_function: prefWindow.value, fft_bits: parseInt(prefDft.value), palette: prefPalette.value,
      lrange: parseInt(prefLow.value), urange: parseInt(prefHigh.value),
      show_preview: (showPreview as any).checked, save_resolution: prefSaveRes.value
    }});
    currentLang=sel||"en"; applyI18n();
    // Apply defaults to current state if no file open (so next file uses them)
    if(!state.path){
      state.windowFunction = prefWindow.value as WindowFn;
      state.fftBits = parseInt(prefDft.value);
      state.palette = prefPalette.value as Palette;
      state.lrange = parseInt(prefLow.value);
      state.urange = parseInt(prefHigh.value);
      rebuildOffscreenFromState(); render();
    }
    showToast(t("Preferences")+" saved"); dlg.removeEventListener("close",handler);
  };
  dlg.addEventListener("close",handler,{once:true});
}
async function openAbout(){
  const dlg=document.getElementById("about-dialog") as HTMLDialogElement;
  const info:any=await invoke("get_app_info");
  (document.getElementById("about-version") as HTMLElement).textContent=info.version;
  (document.getElementById("about-desc") as HTMLElement).textContent=t(info.description) || info.description;
  (document.getElementById("about-copyright") as HTMLElement).textContent=info.copyright;
  (document.getElementById("about-artist") as HTMLElement).textContent=info.artist;
  const ul=document.getElementById("about-devs") as HTMLElement; ul.innerHTML=""; info.developers.forEach((d:string)=>{ const li=document.createElement("li"); li.textContent=d; ul.appendChild(li); });
  dlg.showModal();
}
async function handleAction(action:string){
  switch(action){
    case "open": await openFileDialog(); break;
    case "save": await saveSpectrogram(); break;
    case "exit": const w=getCurrentWindow(); await w.close(); break;
    case "preferences": await openPreferences(); break;
    case "help": await openUrl(`https://help.spek.cc/man-${PACKAGE_VERSION}.html`); break;
    case "about": await openAbout(); break;
  }
}
function handleKey(e:KeyboardEvent){
  let handled=true;
  switch(e.key){
    case "c": if(state.channels) state.channel=(state.channel+1)%state.channels; break;
    case "C": if(state.channels) state.channel=(state.channel-1+state.channels)%state.channels; break;
    case "f": { const o:WindowFn[]=["hann","hamming","blackman-harris"]; const i=o.indexOf(state.windowFunction); state.windowFunction=o[(i+1)%o.length]; break; }
    case "F": { const o:WindowFn[]=["hann","hamming","blackman-harris"]; const i=o.indexOf(state.windowFunction); state.windowFunction=o[(i-1+o.length)%o.length]; break; }
    case "l": state.lrange=Math.min(state.lrange+1, state.urange-1); rebuildOffscreenFromState(); render(); return;
    case "L": state.lrange=Math.max(state.lrange-1, MIN_RANGE); rebuildOffscreenFromState(); render(); return;
    case "p": { const o:Palette[]=["spectrum","sox","mono"]; const i=o.indexOf(state.palette); state.palette=o[(i+1)%o.length]; rebuildOffscreenFromState(); render(); return; }
    case "P": { const o:Palette[]=["spectrum","sox","mono"]; const i=o.indexOf(state.palette); state.palette=o[(i-1+o.length)%o.length]; rebuildOffscreenFromState(); render(); return; }
    case "s": if(state.streams) state.stream=(state.stream+1)%state.streams; break;
    case "S": if(state.streams) state.stream=(state.stream-1+state.streams)%state.streams; break;
    case "u": state.urange=Math.min(state.urange+1, MAX_RANGE); rebuildOffscreenFromState(); render(); return;
    case "U": state.urange=Math.max(state.urange-1, state.lrange+1); rebuildOffscreenFromState(); render(); return;
    case "w": state.fftBits=Math.min(state.fftBits+1, MAX_FFT_BITS); break;
    case "W": state.fftBits=Math.max(state.fftBits-1, MIN_FFT_BITS); break;
    default: handled=false;
  }
  if(handled){ e.preventDefault(); if(["c","C","f","F","s","S","w","W"].includes(e.key)) { cachedKey=""; analyzeCurrent(); } }
}

window.addEventListener("DOMContentLoaded", async ()=>{
  canvas=document.getElementById("spectrogram") as HTMLCanvasElement;
  ctx=canvas.getContext("2d"); container=document.getElementById("canvas-container") as HTMLElement;
  loadingEl=document.getElementById("loading") as HTMLElement; infoBar=document.getElementById("info-bar") as HTMLElement; toastEl=document.getElementById("toast") as HTMLElement;
  // init lang + defaults (window/dft/palette/low/high)
  try{ currentLang=await invoke("get_language") || "en"; if(!translations[currentLang]) currentLang="en"; }catch{}
  try{
    const def:any = await invoke("get_default_settings");
    if (def.window_function) state.windowFunction = def.window_function;
    if (def.fft_bits) state.fftBits = def.fft_bits;
    if (def.palette) state.palette = def.palette;
    if (typeof def.lrange === 'number') state.lrange = def.lrange;
    if (typeof def.urange === 'number') state.urange = def.urange;
  }catch{}
  applyI18n();

  // Menu click handling (open on click, not hover)
  document.querySelectorAll(".menu").forEach(menu=>{
    const title=menu.querySelector(".menu-title") as HTMLElement;
    title.addEventListener("click", (e)=>{
      e.stopPropagation();
      const isOpen=menu.classList.contains("open");
      document.querySelectorAll(".menu.open").forEach(m=>m.classList.remove("open"));
      if(!isOpen) menu.classList.add("open");
    });
    // Latch fix: when a menu is open, hovering over another menu should open it
    menu.addEventListener("mouseenter", ()=>{
      if (document.querySelector(".menu.open") && !menu.classList.contains("open")) {
        document.querySelectorAll(".menu.open").forEach(m=>m.classList.remove("open"));
        menu.classList.add("open");
      }
    });
  });
  document.addEventListener("click", ()=> document.querySelectorAll(".menu.open").forEach(m=>m.classList.remove("open")));
  // Also close on Escape
  document.addEventListener("keydown", (e)=>{ if(e.key==="Escape") document.querySelectorAll(".menu.open").forEach(m=>m.classList.remove("open")); });

  document.querySelectorAll("[data-action]").forEach(el=> el.addEventListener("click", (e)=>{
    const act=(e.currentTarget as HTMLElement).getAttribute("data-action"); if(act) handleAction(act);
    document.querySelectorAll(".menu.open").forEach(m=>m.classList.remove("open"));
  }));
  document.querySelectorAll("[data-open]").forEach(el=> el.addEventListener("click", (e)=>{ e.preventDefault(); const url=(e.currentTarget as HTMLElement).getAttribute("data-open"); if(url) openUrl(url); }));
  infoBar.addEventListener("click", ()=> openUrl("https://www.spek.cc"));
  document.getElementById("info-close")?.addEventListener("click", (e)=>{ e.stopPropagation(); infoBar.classList.add("hidden"); });
  window.addEventListener("keydown", handleKey);
  canvas.tabIndex=0; canvas.focus(); container.addEventListener("click", ()=> canvas.focus());

  // Resize: debounce 400ms and only recompute if samples changed by >5 or >2%
  let resizeTimer:number|undefined; let lastW=0;
  window.addEventListener("resize", ()=>{
    clearTimeout(resizeTimer);
    resizeTimer=window.setTimeout(()=>{
      const rect=container.getBoundingClientRect(); const newSamples=Math.max(1, Math.floor(rect.width - LPAD - RPAD));
      const diff=Math.abs(newSamples - lastW); const pct=lastW? diff/lastW : 1;
      if(state.path && (diff>8 || pct>0.03)){
        lastW=newSamples; cachedKey=""; analyzeCurrent();
      } else if(!state.path) render();
      else render(); // just re-render without recompute for small resizes
    }, 400);
  });

  const overlay=document.getElementById("drop-overlay") as HTMLElement;
  container.addEventListener("dragover", (e)=>{ e.preventDefault(); overlay.classList.remove("hidden"); });
  container.addEventListener("dragleave", ()=> overlay.classList.add("hidden"));
  container.addEventListener("drop", async (e)=>{
    e.preventDefault(); overlay.classList.add("hidden");
    const files=e.dataTransfer?.files;
    if(files && files.length===1){
      const file=files[0] as any;
      if(file.path){ state.path=file.path; state.stream=0; state.channel=0; cachedKey=""; await analyzeCurrent(); }
      else showToast("Drop not supported in browser, use Open dialog");
    }
  });
  try{
    const win=getCurrentWindow();
    win.onDragDropEvent((event)=>{
      if(event.payload.type==="over") overlay.classList.remove("hidden");
      else if(event.payload.type==="drop"){ overlay.classList.add("hidden"); const paths=event.payload.paths; if(paths.length===1){ state.path=paths[0]; state.stream=0; state.channel=0; cachedKey=""; analyzeCurrent(); } }
      else overlay.classList.add("hidden");
    });
  }catch{}

  try{ const res:any=await invoke("check_version"); if(res.update_available) infoBar.classList.remove("hidden"); }catch{}
  render();
  try{
    const cli:any=await invoke("get_cli_args");
    if(cli.version) showToast(`Spek version ${PACKAGE_VERSION}`);
    else if(cli.help) showToast("Usage: spek [FILE] [--help] [--version]");
    else if(cli.file){ state.path=cli.file; state.stream=0; state.channel=0; await analyzeCurrent(); }
  }catch{}
  canvas.focus();
});
