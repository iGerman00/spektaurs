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

interface ProgressBatchPayload {
  start_sample: number;
  count: number;
  bands: number;
  data_u8: number[];
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
    "Decoding…": "Decoding…",
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
    "Decoding…": "Dekodiere…",
    "Preferences": "Einstellungen", "General": "Allgemein", "Language:": "Sprache:", "Check for updates": "Auf Updates prüfen", "OK": "OK", "Close": "Schließen",
    "About Spek": "Über Spek", "Acoustic Spectrum Analyser": "Akustischer Spektrumanalysator", "Spek Website": "Spek-Webseite",
  },
  fr: {
    "File": "Fichier", "Edit": "Édition", "Help": "Aide",
    "Open…": "Ouvrir…", "Save Spectrogram…": "Enregistrer le spectrogramme…", "Exit": "Quitter",
    "Preferences…": "Préférences…", "Help (F1)": "Aide (F1)", "About… (Shift+F1)": "À propos… (Shift+F1)",
    "Open": "Ouvrir", "Save": "Enregistrer",
    "Analysing…": "Analyse…",
    "Decoding…": "Décodage…",
  },
  ja: {
    "File": "ファイル", "Edit": "編集", "Help": "ヘルプ",
    "Open…": "開く…", "Save Spectrogram…": "スペクトログラムを保存…", "Exit": "終了",
    "Analysing…": "解析中…",
    "Decoding…": "デコード中…",
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
  displayHeight: 0,
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
const paletteLutABGR = new Map<string, Uint32Array>();

function getPaletteLUT(palette: Palette): Uint32Array {
  const key = palette;
  if (paletteLUT.has(key)) return paletteLUT.get(key)!;
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const level = i / 255;
    lut[i] = paletteColor(palette, level);
  }
  paletteLUT.set(key, lut);
  return lut;
}

function getPaletteLutABGR(palette: Palette): Uint32Array {
  const key = palette;
  if (paletteLutABGR.has(key)) return paletteLutABGR.get(key)!;
  const rgbLut = getPaletteLUT(palette);
  const lutABGR = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const col = rgbLut[i];
    const r = (col >> 16) & 0xFF;
    const g = (col >> 8) & 0xFF;
    const b = col & 0xFF;
    lutABGR[i] = (0xFF << 24) | (b << 16) | (g << 8) | r;
  }
  paletteLutABGR.set(key, lutABGR);
  return lutABGR;
}

function bitsToBands(bits: number): number {
  return (1 << (bits - 1)) + 1;
}

function timeFormatter(unit: number): string {
  const m = Math.floor(unit / 60);
  const s = unit % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function freqFormatter(unit: number): string {
  return `${unit / 1000} kHz`;
}

function densityFormatter(unit: number): string {
  return `${-unit} dB`;
}

function trimText(ctx: CanvasRenderingContext2D, s: string, length: number, trimEnd: boolean): string {
  if (length <= 0) return "";
  if (ctx.measureText(s).width <= length) return s;
  const fix = "...";
  let i = 0, k = s.length;
  while (k - i > 1) {
    const j = Math.floor((i + k) / 2);
    const cand = trimEnd ? s.substring(0, j) + fix : fix + s.substring(j);
    const ww = ctx.measureText(cand).width;
    if (trimEnd !== (ww > length)) i = j;
    else k = j;
  }
  return trimEnd ? s.substring(0, i) + fix : fix + s.substring(k);
}

class Ruler {
  constructor(
    public x: number,
    public y: number,
    public pos: "top" | "right" | "bottom" | "left",
    public sampleLabel: string,
    public factors: number[],
    public minUnits: number,
    public maxUnits: number,
    public spacing: number,
    public scale: number,
    public offset: number,
    public formatter: (u: number) => string
  ) {}

  draw(ctx: CanvasRenderingContext2D) {
    const size = ctx.measureText(this.sampleLabel);
    const len = (this.pos === "top" || this.pos === "bottom") ? size.width : 12;
    let factor = 0;
    for (const f of this.factors) {
      if (f === 0) break;
      if (Math.abs(this.scale * f) >= this.spacing * len) {
        factor = f;
        break;
      }
    }
    this.drawTick(ctx, this.minUnits);
    this.drawTick(ctx, this.maxUnits);
    if (factor > 0) {
      for (let tick = this.minUnits + factor; tick < this.maxUnits; tick += factor) {
        if (Math.abs(this.scale * (this.maxUnits - tick)) < len * 1.2) break;
        this.drawTick(ctx, tick);
      }
    }
  }

  drawTick(ctx: CanvasRenderingContext2D, tick: number) {
    const GAP = 10, TICK_LEN = 4;
    const label = this.formatter(tick);
    const value = (this.pos === "top" || this.pos === "bottom") ? tick : this.maxUnits + this.minUnits - tick;
    const p = this.offset + this.scale * (value - this.minUnits);
    const w = ctx.measureText(label).width;
    const h = 12;
    const prevBaseline = ctx.textBaseline;
    ctx.textBaseline = "middle";
    if (this.pos === "top") ctx.fillText(label, this.x + p - w / 2, this.y - GAP - h / 2);
    else if (this.pos === "right") ctx.fillText(label, this.x + GAP, this.y + p);
    else if (this.pos === "bottom") ctx.fillText(label, this.x + p - w / 2, this.y + GAP + h / 2);
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

let cachedPaletteCanvas: HTMLCanvasElement | null = null;
let cachedPaletteKey = "";

function getPaletteStripCanvas(palette: Palette, fftBits: number): HTMLCanvasElement {
  const bands = bitsToBands(fftBits);
  const key = `${palette}_${fftBits}`;
  if (cachedPaletteCanvas && cachedPaletteKey === key && cachedPaletteCanvas.height === bands) {
    return cachedPaletteCanvas;
  }
  const pOff = document.createElement("canvas");
  pOff.width = RULER;
  pOff.height = bands;
  const poctx = pOff.getContext("2d");
  if (poctx) {
    const d = poctx.createImageData(RULER, bands);
    const d32 = new Uint32Array(d.data.buffer);
    const lutABGR = getPaletteLutABGR(palette);
    for (let y = 0; y < bands; y++) {
      const level = y / bands;
      const idx = Math.max(0, Math.min(255, Math.floor(level * 255)));
      const colABGR = lutABGR[idx];
      const yy = bands - y - 1;
      for (let x = 0; x < RULER; x++) {
        d32[yy * RULER + x] = colABGR;
      }
    }
    poctx.putImageData(d, 0, 0);
  }
  cachedPaletteCanvas = pOff;
  cachedPaletteKey = key;
  return pOff;
}

let rawQuantized: Uint8Array | null = null;
let offscreenImageData: ImageData | null = null;
let offscreenData32: Uint32Array | null = null;
let offscreenDirty = false;
const currentRemapLUT = new Uint32Array(256);

function updateRemapLUT() {
  const lutABGR = getPaletteLutABGR(state.palette);
  currentRemapLUT[0] = lutABGR[0]; // silence = black
  const range = state.urange - state.lrange;
  for (let i = 1; i < 256; i++) {
    const db = -140.0 + ((i - 1) / 254.0) * 140.0;
    const clamped = Math.max(state.lrange, Math.min(state.urange, db));
    const level = range === 0 ? 0 : (clamped - state.lrange) / range;
    const idx = Math.max(0, Math.min(255, Math.floor(level * 255)));
    currentRemapLUT[i] = lutABGR[idx];
  }
}

function downsampleColumnToDisplay(raw: Uint8Array, colBase: number, bands: number, displayHeight: number, d32: Uint32Array, x: number, samples: number, remap: Uint32Array) {
  const step = (bands - 1) / Math.max(1, displayHeight - 1);
  for (let dy = 0; dy < displayHeight; dy++) {
    // Y=0 is top (highest freq, band bands-1), Y=displayHeight-1 is bottom (lowest freq, band 0)
    const f = (displayHeight - 1 - dy) * step;
    const f0 = Math.floor(f);
    const f1 = Math.min(bands - 1, f0 + 1);
    const t = f - f0;
    const v0 = raw[colBase + f0];
    const v1 = raw[colBase + f1];
    const v = Math.round(v0 * (1 - t) + v1 * t);
    d32[dy * samples + x] = remap[v];
  }
}

function ensureOffscreen(samples: number, displayHeight: number, keepContent = true) {
  if (offscreen && offscreen.width === samples && offscreen.height === displayHeight) return;
  const oldOffscreen = offscreen;
  offscreen = document.createElement("canvas");
  offscreen.width = samples;
  offscreen.height = displayHeight;
  offscreenCtx = offscreen.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  offscreenImageData = offscreenCtx ? offscreenCtx.createImageData(samples, displayHeight) : null;
  offscreenData32 = offscreenImageData ? new Uint32Array(offscreenImageData.data.buffer) : null;
  if (offscreenCtx) {
    if (oldOffscreen && keepContent && oldOffscreen.width > 0 && oldOffscreen.height > 0) {
      offscreenCtx.imageSmoothingEnabled = false;
      offscreenCtx.drawImage(oldOffscreen, 0, 0, samples, displayHeight);
      if (offscreenImageData) {
        const d = offscreenCtx.getImageData(0, 0, samples, displayHeight);
        offscreenImageData.data.set(d.data);
      }
    } else {
      if (offscreenData32) offscreenData32.fill(0xFF000000);
    }
  }
  updateRemapLUT();
}

function rebuildOffscreenFromState() {
  const displayHeight = state.displayHeight;
  if (state.samples <= 0 || state.bands <= 0 || displayHeight <= 0) {
    offscreen = null;
    offscreenCtx = null;
    return;
  }
  ensureOffscreen(state.samples, displayHeight, false);
  if (!offscreenCtx || !offscreen || !offscreenData32 || !offscreenImageData) return;
  const bands = state.bands, samples = state.samples;
  updateRemapLUT();

  if (!rawQuantized || rawQuantized.length !== samples * bands) {
    rawQuantized = new Uint8Array(samples * bands);
    // rawQuantized is populated during streaming; if magnitudes exist, quantize them
    if (state.magnitudes && state.magnitudes.length === samples * bands) {
      for (let i = 0; i < samples * bands; i++) {
        const v = state.magnitudes[i];
        if (v === null || v === undefined || typeof v !== "number" || !isFinite(v) || v <= -140.0) {
          rawQuantized[i] = 0;
        } else {
          rawQuantized[i] = Math.max(1, Math.min(255, Math.floor(((Math.min(0, v) + 140.0) / 140.0) * 254.0) + 1));
        }
      }
    }
  }

  const d32 = offscreenData32;
  const raw = rawQuantized;
  const remap = currentRemapLUT;
  for (let x = 0; x < samples; x++) {
    downsampleColumnToDisplay(raw, x * bands, bands, displayHeight, d32, x, samples, remap);
  }
  offscreenCtx.putImageData(offscreenImageData, 0, 0);
  offscreenDirty = false;
}

function renderScene(c: CanvasRenderingContext2D, w: number, h: number) {
  c.fillStyle = "black";
  c.fillRect(0, 0, w, h);
  c.strokeStyle = "white";
  c.fillStyle = "white";
  c.lineWidth = 1;

  const fontScale = window.devicePixelRatio > 1 ? 1.1 : 1.0;
  const normalFont = `${Math.round(12 * fontScale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const largeFont = `600 ${Math.round(14 * fontScale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const smallFont = `${Math.round(11 * fontScale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const normalHeight = 14, largeHeight = 16;

  // Spek version in top right (aligned baseline)
  c.textBaseline = "alphabetic";
  c.font = largeFont;
  c.fillStyle = "white";
  const pkgY = TPAD - GAP - 6;
  const pkgX = w - RPAD + GAP;
  c.fillText(PACKAGE_NAME, pkgX, pkgY);
  const pkgW = c.measureText(PACKAGE_NAME + " ").width;
  c.font = smallFont;
  c.fillStyle = "#ccc";
  c.fillText(PACKAGE_VERSION, pkgX + pkgW, pkgY);

  const hasImage = state.samples > 0 && state.bands > 1 && offscreen && w - LPAD - RPAD > 0 && h - TPAD - BPAD > 0;
  if (hasImage) {
    const imgW = Math.round(w - LPAD - RPAD);
    const imgH = Math.round(h - TPAD - BPAD);
    c.imageSmoothingEnabled = false;
    c.drawImage(offscreen!, Math.round(LPAD), Math.round(TPAD), imgW, imgH);

    // File name and description
    c.textBaseline = "top";
    c.font = largeFont;
    c.fillStyle = "white";
    const displayName = state.path ? (state.path.split(/[\/\\]/).pop() || state.path) : "";
    const trimmedName = trimText(c, displayName, w - LPAD - RPAD, false);
    c.fillText(trimmedName, LPAD, TPAD - 2 * GAP - normalHeight - largeHeight);
    c.font = normalFont;
    const trimmedDesc = trimText(c, state.desc, w - LPAD - RPAD, true);
    c.fillText(trimmedDesc, LPAD, TPAD - GAP - normalHeight);

    // Rulers
    c.textBaseline = "alphabetic";
    c.font = smallFont;
    c.fillStyle = "white";
    c.strokeStyle = "white";
    if (state.duration > 0) {
      const timeFactors = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 0];
      new Ruler(LPAD, h - BPAD, "bottom", "00:00", timeFactors, 0, Math.floor(state.duration), 1.5, (w - LPAD - RPAD) / state.duration, 0, timeFormatter).draw(c);
    }
    if (state.sampleRate > 0) {
      const freq = Math.floor(state.sampleRate / 2);
      const freqFactors = [1000, 2000, 5000, 10000, 20000, 0];
      new Ruler(LPAD, TPAD, "left", "00 kHz", freqFactors, 0, freq, 3.0, (h - TPAD - BPAD) / freq, 0, freqFormatter).draw(c);
    }
  }

  // Border around the spectrogram
  c.textBaseline = "top";
  c.strokeStyle = "white";
  c.strokeRect(LPAD, TPAD, w - LPAD - RPAD, h - TPAD - BPAD);

  // Palette strip & spectral density ruler
  if (h - TPAD - BPAD > 0) {
    const pOff = getPaletteStripCanvas(state.palette, state.fftBits);
    c.drawImage(pOff, w - RPAD + GAP, TPAD, RULER, h - TPAD - BPAD + 1);
    c.textBaseline = "middle";
    c.font = smallFont;
    c.fillStyle = "white";
    c.strokeStyle = "white";
    const densityFactors = [1, 2, 5, 10, 20, 50, 0];
    new Ruler(w - RPAD + GAP + RULER, TPAD, "right", "-00 dB", densityFactors, -state.urange, -state.lrange, 3.0, (h - TPAD - BPAD) / (state.lrange - state.urange), h - TPAD - BPAD, densityFormatter).draw(c);
    c.textBaseline = "alphabetic";
  }

  // Error / empty prompt
  if (state.error) {
    c.textBaseline = "middle";
    c.textAlign = "center";
    c.font = largeFont;
    c.fillStyle = "#ff6666";
    c.fillText(state.error, w / 2, h / 2);
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
  } else if (!state.path) {
    c.textBaseline = "middle";
    c.textAlign = "center";
    c.font = normalFont;
    c.fillStyle = "#888";
    c.fillText(t("Drop an audio file here or use File → Open"), w / 2, h / 2);
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
  }
}

let lastCanvasW = 0, lastCanvasH = 0;
function render() {
  if (!ctx || !canvas) return;
  if (offscreenDirty && offscreenCtx && offscreenImageData) {
    offscreenCtx.putImageData(offscreenImageData, 0, 0);
    offscreenDirty = false;
  }
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const width = Math.max(0, Math.floor(rect.width));
  const height = Math.max(0, Math.floor(rect.height));
  const cw = width * dpr, ch = height * dpr;
  if (cw !== lastCanvasW || ch !== lastCanvasH) {
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    lastCanvasW = cw;
    lastCanvasH = ch;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  renderScene(ctx, width, height);

  // Update top-bar-tooltip for ellipsed text only (never set container.title)
  const displayName = state.path ? (state.path.split(/[\/\\]/).pop() || state.path) : "";
  const topBar = document.getElementById("top-bar-tooltip");
  if (topBar) {
    const trimmedName = trimText(ctx, displayName, width - LPAD - RPAD, false);
    const trimmedDesc = trimText(ctx, state.desc, width - LPAD - RPAD, true);
    if (trimmedName !== displayName || trimmedDesc !== state.desc) {
      topBar.title = `${displayName}\n${state.desc}`;
    } else {
      topBar.title = "";
    }
  }
}

// ----- Actions -----
async function analyzeCurrent() {
  if (!state.path) return;
  const myGen = ++generation;
  const rect = container.getBoundingClientRect();
  const availW = Math.max(1, Math.floor(rect.width - LPAD - RPAD));
  const samples = availW;
  const displayHeight = Math.max(1, Math.floor(rect.height - TPAD - BPAD));
  state.displayHeight = displayHeight;
  const key = `${state.path}|${state.stream}|${state.channel}|${state.windowFunction}|${state.fftBits}|${samples}|${state.urange}|${state.lrange}|${state.palette}`;

  if (cachedKey === key && cachedResult && lastSamples === samples) {
    Object.assign(state, {
      bands: cachedResult.bands,
      samples: cachedResult.samples,
      sampleRate: cachedResult.sample_rate,
      duration: cachedResult.duration,
      desc: cachedResult.desc,
      magnitudes: cachedResult.magnitudes.slice(),
      streams: cachedResult.streams,
      channels: cachedResult.channels,
      error: cachedResult.error,
    });
    document.title = state.path ? `Spek - ${state.path.split(/[\/\\]/).pop()}` : "Spek - Acoustic Spectrum Analyser";
    rebuildOffscreenFromState();
    render();
    return;
  }

  const bands = bitsToBands(state.fftBits);
  state.bands = bands;
  state.samples = samples;
  state.magnitudes = new Array(samples * bands).fill(NaN);
  state.error = "";
  // Keep previous frame until new columns arrive - do not clear to black immediately!
  ensureOffscreen(samples, displayHeight, true);
  rawQuantized = new Uint8Array(samples * bands);
  render();

  loadingEl.classList.remove("hidden");
  const loadingText = loadingEl.querySelector("span");
  if (loadingText) loadingText.textContent = `${t("Analysing…")} 0%`;

  let showPreview = true;
  try {
    const pref: any = await invoke("get_default_settings");
    showPreview = pref.show_preview !== false;
  } catch {}

  let rafScheduled = false;
  let unlisten: (() => void) | null = null;
  let unlistenDecode: (() => void) | null = null;
  let renderedSample = 0;
  let receivedSample = 0;

  try {
    unlistenDecode = await listen<number>("spectrogram-decode-progress", (ev) => {
      if (myGen !== generation) return;
      const p = ev.payload;
      if (loadingText) {
        loadingText.textContent = p > 0 ? `${t("Decoding…")} ${p}%` : t("Decoding…");
      }
    });
  } catch {}

  if (showPreview) {
    try {
      unlisten = await listen<ProgressBatchPayload>("spectrogram-progress-batch", (ev) => {
        if (myGen !== generation) return;
        const p = ev.payload;
        if (p.bands !== bands || !offscreenData32 || !rawQuantized) return;
        // Zero-cost typed array copy: takes ~0.002ms, returns immediately so CSS animations stay at 165Hz
        rawQuantized.set(p.data_u8, p.start_sample * bands);
        receivedSample = Math.max(receivedSample, p.start_sample + p.count);

        if (!rafScheduled || receivedSample >= samples) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            if (myGen !== generation || !offscreenData32 || !rawQuantized) return;
            const target = Math.min(samples, receivedSample);
            while (renderedSample < target) {
              downsampleColumnToDisplay(rawQuantized, renderedSample * bands, bands, displayHeight, offscreenData32, renderedSample, samples, currentRemapLUT);
              renderedSample++;
            }
            offscreenDirty = true;
            render();
            if (loadingText) {
              loadingText.textContent = `${t("Analysing…")} ${Math.min(100, Math.round((target / samples) * 100))}%`;
            }
          });
        }
      });
    } catch {}
  }

  try {
    const result: SpectrogramResult = await invoke("analyze_audio", {
      params: {
        path: state.path,
        stream: state.stream,
        channel: state.channel,
        window_function: state.windowFunction,
        fft_bits: state.fftBits,
        samples,
        show_preview: showPreview,
      },
    });
    if (unlistenDecode) unlistenDecode();
    if (myGen !== generation) {
      if (unlisten) unlisten();
      return;
    }
    state.bands = result.bands;
    state.samples = result.samples;
    state.sampleRate = result.sample_rate;
    state.duration = result.duration;
    state.desc = result.desc;
    if (result.magnitudes && result.magnitudes.length > 0) {
      state.magnitudes = result.magnitudes.slice();
    }
    state.streams = result.streams;
    state.channels = result.channels;
    state.error = result.error;
    document.title = state.path ? `Spek - ${state.path.split(/[\/\\]/).pop()}` : "Spek - Acoustic Spectrum Analyser";
    cachedResult = { ...result, magnitudes: state.magnitudes };
    cachedKey = key;
    lastSamples = samples;

    if (!showPreview || !offscreen || offscreen.width !== state.samples || offscreen.height !== state.bands) {
      rebuildOffscreenFromState();
    }
  } catch (e: any) {
    if (myGen === generation) {
      state.error = String(e);
      showToast("Error: " + state.error);
    }
  } finally {
    if (unlisten) unlisten();
    if (myGen === generation) {
      loadingEl.classList.add("hidden");
      render();
    }
  }
}

async function openFileDialog() {
  const selected = await dialogOpen({
    title: t("Open…"),
    filters: [
      {
        name: "Audio files",
        extensions: [
          "3gp", "aac", "aif", "aifc", "aiff", "amr", "awb", "ape", "au", "dts",
          "flac", "flv", "gsm", "m4a", "m4p", "mp3", "mp4", "mp+", "mpc", "mpp",
          "oga", "ogg", "opus", "ra", "ram", "snd", "wav", "wma", "wv"
        ],
      },
      { name: "All files", extensions: ["*"] }
    ],
  });
  if (typeof selected === "string" && selected) {
    state.path = selected;
    state.stream = 0;
    state.channel = 0;
    cachedKey = "";
    await analyzeCurrent();
  }
}

async function saveSpectrogram() {
  if (!canvas || state.samples === 0) {
    showToast("No spectrogram to save");
    return;
  }
  const defaultPath = state.path ? (state.path.split(/[\/\\]/).pop() + ".png") : "Untitled.png";
  const selected = await dialogSave({
    title: t("Save Spectrogram…"),
    defaultPath,
    filters: [{ name: "PNG images", extensions: ["png"] }],
  });
  if (!selected) return;

  let saveW = canvas.clientWidth || 960;
  let saveH = canvas.clientHeight || 640;
  try {
    const prefs: any = await invoke("get_default_settings");
    const res = prefs.save_resolution || "window";
    if (res === "original" && state.samples > 0 && state.bands > 0) {
      saveW = state.samples + LPAD + RPAD;
      saveH = state.bands + TPAD + BPAD;
    } else if (res.includes("x")) {
      const [wStr, hStr] = res.split("x");
      saveW = parseInt(wStr) || saveW;
      saveH = parseInt(hStr) || saveH;
    }
  } catch {}

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = saveW;
  exportCanvas.height = saveH;
  const expCtx = exportCanvas.getContext("2d");
  if (expCtx) {
    const origDisplayH = state.displayHeight;
    const saveImgH = Math.max(1, Math.floor(saveH - TPAD - BPAD));
    if (saveImgH !== origDisplayH && rawQuantized && state.samples > 0 && state.bands > 0) {
      state.displayHeight = saveImgH;
      rebuildOffscreenFromState();
      renderScene(expCtx, saveW, saveH);
      state.displayHeight = origDisplayH;
      rebuildOffscreenFromState();
    } else {
      renderScene(expCtx, saveW, saveH);
    }
  }
  const dataUrl = exportCanvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1];
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  try {
    // @ts-ignore
    await writeFile(selected, bytes);
    showToast("Saved to " + selected);
  } catch {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = selected.split(/[\/\\]/).pop() || "spectrogram.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast("Saved (download)");
  }
}
function showToast(msg:string){ toastEl.textContent=msg; toastEl.classList.remove("hidden"); setTimeout(()=>toastEl.classList.add("hidden"),3000); }
async function openPreferences() {
  const dlg=document.getElementById("prefs-dialog") as HTMLDialogElement;
  const langSelect=document.getElementById("language-select") as HTMLSelectElement;
  const checkUpdate=document.getElementById("check-update") as HTMLInputElement;
  const showPreview=document.getElementById("show-preview") as HTMLInputElement;
  const showShortcuts=document.getElementById("show-shortcuts") as HTMLInputElement;
  const prefWindow=document.getElementById("pref-window") as HTMLSelectElement;
  const prefDft=document.getElementById("pref-dft") as HTMLSelectElement;
  const prefPalette=document.getElementById("pref-palette") as HTMLSelectElement;
  const prefLow=document.getElementById("pref-low") as HTMLInputElement;
  const prefHigh=document.getElementById("pref-high") as HTMLInputElement;
  const prefSaveRes=document.getElementById("pref-save-res") as HTMLSelectElement;
  const hintEl=document.getElementById("hint") as HTMLElement;

  langSelect.innerHTML=""; const langs:[string,string][]=await invoke("get_available_languages");
  const curLang:string=await invoke("get_language"); const checkVal:boolean=await invoke("get_check_update");
  const defaults:any = await invoke("get_default_settings");
  checkUpdate.checked=checkVal;
  if (showPreview) (showPreview as any).checked = defaults.show_preview !== false;
  if (showShortcuts) {
    (showShortcuts as any).checked = defaults.show_shortcuts !== false;
    showShortcuts.onchange = () => {
      if (hintEl) {
        hintEl.classList.toggle("hidden", !showShortcuts.checked);
        render();
      }
    };
  }
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
    const shortcutsOn = showShortcuts ? (showShortcuts as any).checked : true;
    await invoke("set_default_settings",{settings:{
      window_function: prefWindow.value, fft_bits: parseInt(prefDft.value), palette: prefPalette.value,
      lrange: parseInt(prefLow.value), urange: parseInt(prefHigh.value),
      show_preview: showPreview ? (showPreview as any).checked : true,
      show_shortcuts: shortcutsOn,
      save_resolution: prefSaveRes.value
    }});
    if (hintEl) {
      hintEl.classList.toggle("hidden", !shortcutsOn);
      render();
    }
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
let recolorRafPending = false;
function scheduleRecolor() {
  if (!recolorRafPending) {
    recolorRafPending = true;
    requestAnimationFrame(() => {
      recolorRafPending = false;
      rebuildOffscreenFromState();
      render();
    });
  }
}

let analyzeDebounceTimer: number | undefined;
function debouncedAnalyze(delay = 50) {
  clearTimeout(analyzeDebounceTimer);
  analyzeDebounceTimer = window.setTimeout(() => {
    cachedKey = "";
    analyzeCurrent();
  }, delay);
}

// Reset dynamic range to default (-120 dB to 0 dB or user preferences defaults)
async function resetDynamicRange() {
  try {
    const def: any = await invoke("get_default_settings");
    state.lrange = typeof def.lrange === 'number' ? def.lrange : LRANGE_DEFAULT;
    state.urange = typeof def.urange === 'number' ? def.urange : URANGE_DEFAULT;
  } catch {
    state.lrange = LRANGE_DEFAULT;
    state.urange = URANGE_DEFAULT;
  }
  scheduleRecolor();
  showToast(`Range reset: ${state.lrange} dB to ${state.urange} dB`);
}

function handleKey(e: KeyboardEvent) {
  let handled = true;
  switch (e.key) {
    case "c": if (state.channels) { state.channel = (state.channel + 1) % state.channels; debouncedAnalyze(); } break;
    case "C": if (state.channels) { state.channel = (state.channel - 1 + state.channels) % state.channels; debouncedAnalyze(); } break;
    case "f": { const o: WindowFn[] = ["hann", "hamming", "blackman-harris"]; const i = o.indexOf(state.windowFunction); state.windowFunction = o[(i + 1) % o.length]; debouncedAnalyze(); break; }
    case "F": { const o: WindowFn[] = ["hann", "hamming", "blackman-harris"]; const i = o.indexOf(state.windowFunction); state.windowFunction = o[(i - 1 + o.length) % o.length]; debouncedAnalyze(); break; }
    case "l": state.lrange = Math.min(state.lrange + 1, state.urange - 1); scheduleRecolor(); break;
    case "L": state.lrange = Math.max(state.lrange - 1, MIN_RANGE); scheduleRecolor(); break;
    case "p": { const o: Palette[] = ["spectrum", "sox", "mono"]; const i = o.indexOf(state.palette); state.palette = o[(i + 1) % o.length]; scheduleRecolor(); break; }
    case "P": { const o: Palette[] = ["spectrum", "sox", "mono"]; const i = o.indexOf(state.palette); state.palette = o[(i - 1 + o.length) % o.length]; scheduleRecolor(); break; }
    case "s": if (state.streams) { state.stream = (state.stream + 1) % state.streams; debouncedAnalyze(); } break;
    case "S": if (state.streams) { state.stream = (state.stream - 1 + state.streams) % state.streams; debouncedAnalyze(); } break;
    case "u": state.urange = Math.min(state.urange + 1, MAX_RANGE); scheduleRecolor(); break;
    case "U": state.urange = Math.max(state.urange - 1, state.lrange + 1); scheduleRecolor(); break;
    case "w": state.fftBits = Math.min(state.fftBits + 1, MAX_FFT_BITS); debouncedAnalyze(); break;
    case "W": state.fftBits = Math.max(state.fftBits - 1, MIN_FFT_BITS); debouncedAnalyze(); break;
    case "r": case "R": resetDynamicRange(); break;
    default: handled = false;
  }
  if (handled) {
    e.preventDefault();
  }
}

window.addEventListener("DOMContentLoaded", async ()=>{
  canvas=document.getElementById("spectrogram") as HTMLCanvasElement;
  ctx=canvas.getContext("2d"); container=document.getElementById("canvas-container") as HTMLElement;
  loadingEl=document.getElementById("loading") as HTMLElement; infoBar=document.getElementById("info-bar") as HTMLElement; toastEl=document.getElementById("toast") as HTMLElement;
  const hintEl=document.getElementById("hint") as HTMLElement;
  // init lang + defaults (window/dft/palette/low/high/shortcuts)
  try{ currentLang=await invoke("get_language") || "en"; if(!translations[currentLang]) currentLang="en"; }catch{}
  try{
    const def:any = await invoke("get_default_settings");
    if (def.window_function) state.windowFunction = def.window_function;
    if (def.fft_bits) state.fftBits = def.fft_bits;
    if (def.palette) state.palette = def.palette;
    if (typeof def.lrange === 'number') state.lrange = def.lrange;
    if (typeof def.urange === 'number') state.urange = def.urange;
    if (def.show_shortcuts !== undefined && hintEl) {
      hintEl.classList.toggle("hidden", def.show_shortcuts === false);
      render();
    }
  }catch{}
  // Ensure top-bar tooltip element exists (for stream text hover only)
  if (!document.getElementById("top-bar-tooltip")) {
    const tip = document.createElement("div");
    tip.id = "top-bar-tooltip";
    tip.style.position = "absolute";
    tip.style.left = LPAD + "px";
    tip.style.top = (TPAD - 2*GAP - 20) + "px";
    tip.style.width = "calc(100% - " + (LPAD+RPAD) + "px)";
    tip.style.height = "20px";
    tip.style.pointerEvents = "auto";
    tip.style.zIndex = "5";
    container.appendChild(tip);
  }
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

  // Middle-click (or auxclick) resets dynamic range to default (-120 dB to 0 dB)
  container.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      e.preventDefault();
      resetDynamicRange();
    }
  });
  container.addEventListener("mousedown", (e) => {
    if (e.button === 1) {
      e.preventDefault();
      resetDynamicRange();
    }
  });

  // Mouse wheel bindings:
  // Wheel UP: increase visibility (raise lrange threshold, brightening signal)
  // Wheel DOWN: decrease visibility (lower lrange threshold, dimming noise floor)
  // Shift + Wheel UP: raise high limit (urange towards 0 dB)
  // Shift + Wheel DOWN: lower high limit (urange towards lrange)
  // Ctrl + Wheel: step FFT size (w / W)
  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    // In WebKit/Blink browsers, Shift+Wheel redirects vertical deltaY to deltaX
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    const dir = delta < 0 ? 1 : -1;
    const step = e.altKey ? 5 : (Math.abs(delta) > 50 ? 2 : 1);

    if (e.ctrlKey) {
      if (dir > 0) {
        state.fftBits = Math.min(MAX_FFT_BITS, state.fftBits + 1);
      } else {
        state.fftBits = Math.max(MIN_FFT_BITS, state.fftBits - 1);
      }
      debouncedAnalyze(100);
    } else if (e.shiftKey) {
      state.urange = Math.max(state.lrange + 1, Math.min(MAX_RANGE, state.urange + dir * step));
      scheduleRecolor();
    } else {
      state.lrange = Math.max(MIN_RANGE, Math.min(state.urange - 1, state.lrange + dir * step));
      scheduleRecolor();
    }
  }, { passive: false });

  // Resize: debounce 200ms and recompute if samples changed by >8 or >3%, or re-downsample if height changed
  let resizeTimer: number | undefined;
  let lastW = 0;
  let lastH = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const rect = container.getBoundingClientRect();
      const newSamples = Math.max(1, Math.floor(rect.width - LPAD - RPAD));
      const newDisplayHeight = Math.max(1, Math.floor(rect.height - TPAD - BPAD));
      const diffW = Math.abs(newSamples - lastW);
      const pctW = lastW ? diffW / lastW : 1;
      const diffH = Math.abs(newDisplayHeight - lastH);
      if (state.path && (diffW > 8 || pctW > 0.03)) {
        lastW = newSamples;
        lastH = newDisplayHeight;
        cachedKey = "";
        analyzeCurrent();
      } else if (state.path && diffH > 2) {
        lastH = newDisplayHeight;
        state.displayHeight = newDisplayHeight;
        rebuildOffscreenFromState();
        render();
      } else {
        render();
      }
    }, 200);
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
