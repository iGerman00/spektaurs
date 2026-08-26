import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

// ----- Constants mirrors spek-spectrogram.cc -----
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
  magnitudes: [] as number[], // flat samples * bands
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

// ----- Palette (port of palette.cc) -----
function spectrum(level: number): number {
  level *= 0.6625;
  let r = 0, g = 0, b = 0;
  if (level >= 0 && level < 0.15) {
    r = (0.15 - level) / (0.15 + 0.075);
    g = 0;
    b = 1;
  } else if (level >= 0.15 && level < 0.275) {
    r = 0;
    g = (level - 0.15) / (0.275 - 0.15);
    b = 1;
  } else if (level >= 0.275 && level < 0.325) {
    r = 0;
    g = 1;
    b = (0.325 - level) / (0.325 - 0.275);
  } else if (level >= 0.325 && level < 0.5) {
    r = (level - 0.325) / (0.5 - 0.325);
    g = 1;
    b = 0;
  } else if (level >= 0.5 && level < 0.6625) {
    r = 1;
    g = (0.6625 - level) / (0.6625 - 0.5);
    b = 0;
  }
  let cf = 1;
  if (level >= 0 && level < 0.1) cf = level / 0.1;
  cf *= 255;
  const rr = Math.floor(r * cf + 0.5);
  const gg = Math.floor(g * cf + 0.5);
  const bb = Math.floor(b * cf + 0.5);
  return (rr << 16) + (gg << 8) + bb;
}

function sox(level: number): number {
  let r = 0;
  if (level >= 0.13 && level < 0.73) {
    r = Math.sin((level - 0.13) / 0.60 * Math.PI / 2);
  } else if (level >= 0.73) r = 1;
  let g = 0;
  if (level >= 0.6 && level < 0.91) {
    g = Math.sin((level - 0.6) / 0.31 * Math.PI / 2);
  } else if (level >= 0.91) g = 1;
  let b = 0;
  if (level < 0.60) b = 0.5 * Math.sin(level / 0.6 * Math.PI);
  else if (level >= 0.78) b = (level - 0.78) / 0.22;
  const rr = Math.floor(r * 255 + 0.5);
  const gg = Math.floor(g * 255 + 0.5);
  const bb = Math.floor(b * 255 + 0.5);
  return (rr << 16) + (gg << 8) + bb;
}

function mono(level: number): number {
  const v = Math.floor(level * 255 + 0.5);
  return (v << 16) + (v << 8) + v;
}

function paletteColor(palette: Palette, level: number): number {
  switch (palette) {
    case "spectrum": return spectrum(level);
    case "sox": return sox(level);
    case "mono": return mono(level);
  }
}

// ----- Helpers -----
function bitsToBands(bits: number): number {
  return (1 << (bits - 1)) + 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Formatters
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

// Trim like spek-spectrogram.cc
function trimText(ctx: CanvasRenderingContext2D, s: string, length: number, trimEnd: boolean): string {
  if (length <= 0) return "";
  const w = ctx.measureText(s).width;
  if (w <= length) return s;
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

// Ruler port
class Ruler {
  constructor(
    public x: number, public y: number,
    public pos: "top" | "right" | "bottom" | "left",
    public sampleLabel: string,
    public factors: number[],
    public minUnits: number, public maxUnits: number,
    public spacing: number, public scale: number, public offset: number,
    public formatter: (u: number) => string
  ) {}
  draw(ctx: CanvasRenderingContext2D) {
    const size = ctx.measureText(this.sampleLabel);
    // approximate height via font size
    const len = (this.pos === "top" || this.pos === "bottom") ? size.width : 12; // height approx
    let factor = 0;
    for (const f of this.factors) {
      if (f === 0) break;
      if (Math.abs(this.scale * f) >= this.spacing * len) { factor = f; break; }
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
    const h = 12; // approx
    if (this.pos === "top") {
      ctx.fillText(label, this.x + p - w / 2, this.y - GAP - h);
    } else if (this.pos === "right") {
      ctx.fillText(label, this.x + GAP, this.y + p + h/3);
    } else if (this.pos === "bottom") {
      ctx.fillText(label, this.x + p - w / 2, this.y + GAP + h);
    } else if (this.pos === "left") {
      ctx.fillText(label, this.x - w - GAP, this.y + p + h/3);
    }
    ctx.beginPath();
    if (this.pos === "top") { ctx.moveTo(this.x + p, this.y); ctx.lineTo(this.x + p, this.y - TICK_LEN); }
    else if (this.pos === "right") { ctx.moveTo(this.x, this.y + p); ctx.lineTo(this.x + TICK_LEN, this.y + p); }
    else if (this.pos === "bottom") { ctx.moveTo(this.x + p, this.y); ctx.lineTo(this.x + p, this.y + TICK_LEN); }
    else if (this.pos === "left") { ctx.moveTo(this.x, this.y + p); ctx.lineTo(this.x - TICK_LEN, this.y + p); }
    ctx.stroke();
  }
}

// ----- Rendering -----
function render() {
  if (!ctx || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const width = Math.max(0, rect.width);
  const height = Math.max(0, rect.height);
  // Set canvas size for HiDPI
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = width;
  const h = height;

  // Clear
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "white";
  ctx.fillStyle = "white";
  ctx.lineWidth = 1;

  // Font setup (scale for platform)
  const fontScale = 1.0; // TODO platform font scale 1.3 on mac
  const normalFont = `${Math.round(9 * fontScale)}px sans-serif`;
  const largeFont = `bold ${Math.round(10 * fontScale)}px sans-serif`;
  const smallFont = `${Math.round(8 * fontScale)}px sans-serif`;

  ctx.font = normalFont;
  const normalHeight = 12;
  ctx.font = largeFont;
  const largeHeight = 14;
  ctx.font = smallFont;
  const smallHeight = 10;

  // Top right version info
  ctx.font = largeFont;
  ctx.fillStyle = "white";
  const pkgName = PACKAGE_NAME;
  const pkgNameWidth = ctx.measureText(pkgName + " ").width;
  ctx.fillText(pkgName, w - RPAD + GAP, TPAD - 2 * GAP - normalHeight - largeHeight);
  ctx.font = smallFont;
  ctx.fillText(PACKAGE_VERSION, w - RPAD + GAP + pkgNameWidth, TPAD - 2 * GAP - normalHeight - smallHeight);

  // If we have spectrogram data
  const hasImage = state.samples > 0 && state.bands > 1 && state.magnitudes.length > 0 && w - LPAD - RPAD > 0 && h - TPAD - BPAD > 0;
  if (hasImage) {
    // Create offscreen image data for spectrogram
    const imgW = w - LPAD - RPAD;
    const imgH = h - TPAD - BPAD;
    const bands = state.bands;
    const samples = state.samples;
    // Build image at native resolution then scale via drawImage
    // Create temporary canvas for spectrogram source
    const off = document.createElement("canvas");
    off.width = samples;
    off.height = bands;
    const octx = off.getContext("2d");
    if (octx) {
      const imgData = octx.createImageData(samples, bands);
      const range = state.urange - state.lrange;
      for (let x = 0; x < samples; x++) {
        for (let y = 0; y < bands; y++) {
          const val = state.magnitudes[x * bands + y];
          const clamped = clamp(val, state.lrange, state.urange);
          const level = (clamped - state.lrange) / range;
          const col = paletteColor(state.palette, level);
          const r = (col >> 16) & 0xFF;
          const g = (col >> 8) & 0xFF;
          const b = col & 0xFF;
          // bands - y -1 flip vertical: low freq at bottom? Original: image.SetRGB(sample, bands - y -1 ...)
          const yy = bands - y - 1;
          const idx = (yy * samples + x) * 4;
          imgData.data[idx] = r;
          imgData.data[idx + 1] = g;
          imgData.data[idx + 2] = b;
          imgData.data[idx + 3] = 255;
        }
      }
      octx.putImageData(imgData, 0, 0);
      // Draw scaled
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, LPAD, TPAD, imgW, imgH);
    }

    // File name
    ctx.font = largeFont;
    ctx.fillStyle = "white";
    const displayPath = state.path ? state.path.split(/[\\/]/).pop() || state.path : "";
    ctx.fillText(trimText(ctx, state.path ? displayPath : "", w - LPAD - RPAD, false), LPAD, TPAD - 2 * GAP - normalHeight - largeHeight);
    ctx.font = normalFont;
    ctx.fillText(trimText(ctx, state.desc, w - LPAD - RPAD, true), LPAD, TPAD - GAP - normalHeight);

    // Rulers
    ctx.font = smallFont;
    ctx.fillStyle = "white";
    ctx.strokeStyle = "white";
    if (state.duration) {
      const timeFactors = [1,2,5,10,20,30,60,120,300,600,1200,1800,0];
      const r = new Ruler(LPAD, h - BPAD, "bottom", "00:00", timeFactors, 0, Math.floor(state.duration), 1.5, (w - LPAD - RPAD)/state.duration, 0, timeFormatter);
      r.draw(ctx);
    }
    if (state.sampleRate) {
      const freq = Math.floor(state.sampleRate/2);
      const freqFactors = [1000,2000,5000,10000,20000,0];
      const r = new Ruler(LPAD, TPAD, "left", "00 kHz", freqFactors, 0, freq, 3.0, (h - TPAD - BPAD)/freq, 0, freqFormatter);
      r.draw(ctx);
    }
  }

  // Border
  ctx.strokeStyle = "white";
  ctx.strokeRect(LPAD, TPAD, w - LPAD - RPAD, h - TPAD - BPAD);

  // Palette strip
  if (h - TPAD - BPAD > 0) {
    const paletteBands = bitsToBands(state.fftBits);
    const pOff = document.createElement("canvas");
    pOff.width = RULER;
    pOff.height = paletteBands;
    const poctx = pOff.getContext("2d");
    if (poctx) {
      const d = poctx.createImageData(RULER, paletteBands);
      for (let y = 0; y < paletteBands; y++) {
        const level = y / paletteBands;
        const col = paletteColor(state.palette, level);
        const r = (col >> 16) & 0xFF;
        const g = (col >> 8) & 0xFF;
        const b = col & 0xFF;
        const yy = paletteBands - y - 1;
        for (let x = 0; x < RULER; x++) {
          const idx = (yy * RULER + x) * 4;
          d.data[idx]=r; d.data[idx+1]=g; d.data[idx+2]=b; d.data[idx+3]=255;
        }
      }
      poctx.putImageData(d,0,0);
      ctx.drawImage(pOff, w - RPAD + GAP, TPAD, RULER, h - TPAD - BPAD + 1);
    }
    ctx.font = smallFont;
    ctx.fillStyle = "white";
    ctx.strokeStyle = "white";
    const densityFactors = [1,2,5,10,20,50,0];
    const dr = new Ruler(w - RPAD + GAP + RULER, TPAD, "right", "-00 dB", densityFactors, -state.urange, -state.lrange, 3.0, (h - TPAD - BPAD)/(state.lrange - state.urange), h - TPAD - BPAD, densityFormatter);
    dr.draw(ctx);
  }

  // If error, show centered message
  if (state.error) {
    ctx.font = largeFont;
    ctx.fillStyle = "#ff6666";
    ctx.textAlign = "center";
    ctx.fillText(state.error, w/2, h/2);
    ctx.textAlign = "left";
  } else if (!state.path) {
    ctx.font = normalFont;
    ctx.fillStyle = "#888";
    ctx.textAlign = "center";
    ctx.fillText("Drop an audio file here or use File → Open", w/2, h/2);
    ctx.textAlign = "left";
  }
}

// ----- Actions -----
async function analyzeCurrent() {
  if (!state.path) return;
  const rect = container.getBoundingClientRect();
  const availW = Math.max(1, Math.floor(rect.width - LPAD - RPAD));
  const samples = availW;
  // Clamp samples at least 1
  loadingEl.classList.remove("hidden");
  try {
    const result: SpectrogramResult = await invoke("analyze_audio", {
      params: {
        path: state.path,
        stream: state.stream,
        channel: state.channel,
        window_function: state.windowFunction,
        fft_bits: state.fftBits,
        samples: samples,
      }
    });
    state.bands = result.bands;
    state.samples = result.samples;
    state.sampleRate = result.sample_rate;
    state.duration = result.duration;
    state.desc = result.desc;
    state.magnitudes = result.magnitudes;
    state.streams = result.streams;
    state.channels = result.channels;
    state.error = result.error;
    // If backend returned streams/channels update but invalid channel/stream? adjust
    document.title = state.path ? `Spek - ${state.path.split(/[\\/]/).pop()}` : "Spek - Acoustic Spectrum Analyser";
  } catch (e: any) {
    state.error = String(e);
    showToast("Error: " + state.error);
  } finally {
    loadingEl.classList.add("hidden");
    render();
  }
}

async function openFileDialog() {
  const selected = await dialogOpen({
    title: "Open Audio File",
    filters: [
      { name: "Audio files", extensions: ["3gp","aac","aif","aifc","aiff","amr","awb","ape","au","dts","flac","flv","gsm","m4a","m4p","mp3","mp4","mp+","mpc","mpp","oga","ogg","opus","ra","ram","snd","wav","wma","wv"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (typeof selected === "string" && selected) {
    state.path = selected;
    state.stream = 0;
    state.channel = 0;
    await analyzeCurrent();
  }
}

async function saveSpectrogram() {
  if (!canvas || state.samples === 0) {
    showToast("No spectrogram to save");
    return;
  }
  const selected = await dialogSave({
    title: "Save Spectrogram",
    defaultPath: (state.path ? state.path.split(/[\\/]/).pop() + ".png" : "Untitled.png"),
    filters: [{ name: "PNG images", extensions: ["png"] }]
  });
  if (!selected) return;
  // Use canvas to export PNG: need to render at export resolution? For now export current canvas
  // Create high-quality export by re-rendering at larger size? Use current displayed canvas
  // Convert to blob then write via fs plugin? Simpler: use canvas.toDataURL and invoke write via tauri fs
  // But we can use the HTML canvas's toDataURL and then use invoke to write file via fs.
  // For simplicity, use fetch data URL to bytes
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1];
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  // Use fs plugin: writeFile
  // Dynamically import to avoid bundling issues
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  // writeFile expects string path and Uint8Array
  try {
    // @ts-ignore - tauri fs writeFile signature
    await writeFile(selected, bytes);
    showToast("Saved to " + selected);
  } catch (e) {
    // Fallback: try invoke with rust? Or use anchor download
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = selected.split(/[\\/]/).pop() || "spectrogram.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast("Saved (download)");
  }
}

function showToast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 3000);
}

async function openPreferences() {
  const dlg = document.getElementById("prefs-dialog") as HTMLDialogElement;
  const langSelect = document.getElementById("language-select") as HTMLSelectElement;
  const checkUpdate = document.getElementById("check-update") as HTMLInputElement;
  // Populate languages
  langSelect.innerHTML = "";
  const langs: [string,string][] = await invoke("get_available_languages");
  const currentLang: string = await invoke("get_language");
  const checkVal: boolean = await invoke("get_check_update");
  checkUpdate.checked = checkVal;
  // Hide language selector on Linux per can_change_language
  const canChange = true; // we could query backend platform::can_change_language via command, but assume true for now
  const field = document.getElementById("language-field")!;
  if (!canChange) field.style.display = "none";
  else field.style.display = "";

  langs.forEach(([code, name]) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name || "(system default)";
    if (code === currentLang) opt.selected = true;
    // First two entries are special: "" , ""
    langSelect.appendChild(opt);
  });
  // Fallback: if no match, select 0
  if (!Array.from(langSelect.options).some(o=>o.selected) && langSelect.options.length) langSelect.selectedIndex = 0;

  dlg.showModal();
  const handler = async () => {
    const selCode = langSelect.value;
    await invoke("set_language", { value: selCode });
    await invoke("set_check_update", { value: checkUpdate.checked });
    showToast("Preferences saved");
    dlg.removeEventListener("close", handler);
  };
  dlg.addEventListener("close", handler, { once: true });
}

async function openAbout() {
  const dlg = document.getElementById("about-dialog") as HTMLDialogElement;
  const info: any = await invoke("get_app_info");
  (document.getElementById("about-version") as HTMLElement).textContent = info.version;
  (document.getElementById("about-desc") as HTMLElement).textContent = info.description;
  (document.getElementById("about-copyright") as HTMLElement).textContent = info.copyright;
  (document.getElementById("about-artist") as HTMLElement).textContent = info.artist;
  const devUl = document.getElementById("about-devs") as HTMLElement;
  devUl.innerHTML = "";
  info.developers.forEach((d: string) => {
    const li = document.createElement("li");
    li.textContent = d;
    devUl.appendChild(li);
  });
  dlg.showModal();
}

async function handleAction(action: string) {
  switch(action) {
    case "open": await openFileDialog(); break;
    case "save": await saveSpectrogram(); break;
    case "exit":
      const win = getCurrentWindow();
      await win.close();
      break;
    case "preferences": await openPreferences(); break;
    case "help":
      await openUrl(`https://help.spek.cc/man-${PACKAGE_VERSION}.html`);
      break;
    case "about": await openAbout(); break;
  }
}

// ----- Keyboard shortcuts -----
function handleKey(e: KeyboardEvent) {
  let handled = true;
  switch(e.key) {
    case "c": if (state.channels) state.channel = (state.channel + 1) % state.channels; break;
    case "C": if (state.channels) state.channel = (state.channel - 1 + state.channels) % state.channels; break;
    case "f": {
      const order: WindowFn[] = ["hann","hamming","blackman-harris"];
      const idx = order.indexOf(state.windowFunction);
      state.windowFunction = order[(idx+1)%order.length];
      break;
    }
    case "F": {
      const order: WindowFn[] = ["hann","hamming","blackman-harris"];
      const idx = order.indexOf(state.windowFunction);
      state.windowFunction = order[(idx -1 + order.length)%order.length];
      break;
    }
    case "l": state.lrange = Math.min(state.lrange + 1, state.urange - 1); handled = true; render(); return;
    case "L": state.lrange = Math.max(state.lrange - 1, MIN_RANGE); handled = true; render(); return;
    case "p": {
      const order: Palette[] = ["spectrum","sox","mono"];
      const idx = order.indexOf(state.palette);
      state.palette = order[(idx+1)%order.length];
      handled = true; render(); return;
    }
    case "P": {
      const order: Palette[] = ["spectrum","sox","mono"];
      const idx = order.indexOf(state.palette);
      state.palette = order[(idx -1 + order.length)%order.length];
      handled = true; render(); return;
    }
    case "s": if (state.streams) state.stream = (state.stream + 1) % state.streams; break;
    case "S": if (state.streams) state.stream = (state.stream -1 + state.streams)%state.streams; break;
    case "u": state.urange = Math.min(state.urange + 1, MAX_RANGE); handled = true; render(); return;
    case "U": state.urange = Math.max(state.urange - 1, state.lrange + 1); handled = true; render(); return;
    case "w": state.fftBits = Math.min(state.fftBits + 1, MAX_FFT_BITS); break;
    case "W": state.fftBits = Math.max(state.fftBits - 1, MIN_FFT_BITS); break;
    default: handled = false;
  }
  if (handled) {
    e.preventDefault();
    if (["c","C","f","F","s","S","w","W"].includes(e.key)) {
      analyzeCurrent();
    } else {
      // already rendered for l/L etc
    }
  }
}

// ----- Init -----
window.addEventListener("DOMContentLoaded", async () => {
  canvas = document.getElementById("spectrogram") as HTMLCanvasElement;
  ctx = canvas.getContext("2d");
  container = document.getElementById("canvas-container") as HTMLElement;
  loadingEl = document.getElementById("loading") as HTMLElement;
  infoBar = document.getElementById("info-bar") as HTMLElement;
  toastEl = document.getElementById("toast") as HTMLElement;

  // Menu/toolbar actions
  document.querySelectorAll("[data-action]").forEach(el => {
    el.addEventListener("click", (e) => {
      const act = (e.currentTarget as HTMLElement).getAttribute("data-action");
      if (act) handleAction(act);
    });
  });
  // Link open for website
  document.querySelectorAll("[data-open]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const url = (e.currentTarget as HTMLElement).getAttribute("data-open");
      if (url) openUrl(url);
    });
  });
  // Info bar
  infoBar.addEventListener("click", () => openUrl("https://www.spek.cc"));
  document.getElementById("info-close")?.addEventListener("click", (e) => { e.stopPropagation(); infoBar.classList.add("hidden"); });

  // Keyboard
  window.addEventListener("keydown", handleKey);
  // Make canvas focusable for keyboard
  canvas.tabIndex = 0;
  canvas.focus();
  container.addEventListener("click", () => canvas.focus());

  // Resize
  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      // Only re-analyze if path exists and width changed significantly
      if (state.path) analyzeCurrent();
      else render();
    }, 200);
  });

  // Drag & Drop
  const overlay = document.getElementById("drop-overlay") as HTMLElement;
  container.addEventListener("dragover", (e) => { e.preventDefault(); overlay.classList.remove("hidden"); });
  container.addEventListener("dragleave", () => overlay.classList.add("hidden"));
  container.addEventListener("drop", async (e) => {
    e.preventDefault();
    overlay.classList.add("hidden");
    const files = e.dataTransfer?.files;
    if (files && files.length === 1) {
      // For web drag, we get File object; need to handle via Tauri? In Tauri dragDrop event, path is available via window event
      // If we have File, we can try to get path via webkitRelativePath? For Tauri, we need to listen to window file drop
      const file = files[0] as any;
      // Try to get path from Tauri event instead
      if (file.path) {
        state.path = file.path;
        state.stream = 0;
        state.channel = 0;
        await analyzeCurrent();
      } else {
        showToast("Drop not supported in browser, use Open dialog");
      }
    }
  });
  // Tauri window drag drop
  try {
    const win = getCurrentWindow();
    win.onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        overlay.classList.remove("hidden");
      } else if (event.payload.type === "drop") {
        overlay.classList.add("hidden");
        const paths = event.payload.paths;
        if (paths.length === 1) {
          state.path = paths[0];
          state.stream = 0;
          state.channel = 0;
          analyzeCurrent();
        }
      } else {
        overlay.classList.add("hidden");
      }
    });
  } catch {}

  // Check for update
  try {
    const res: any = await invoke("check_version");
    if (res.update_available) {
      infoBar.classList.remove("hidden");
    }
  } catch {}

  // Initial render
  render();

  // Handle initial file from CLI args (mirrors spek.cc FILE param)
  try {
    const cli: any = await invoke("get_cli_args");
    if (cli.version) {
      showToast(`Spek version ${PACKAGE_VERSION}`);
    } else if (cli.help) {
      showToast("Usage: spek [FILE] [--help] [--version]");
    } else if (cli.file) {
      state.path = cli.file;
      state.stream = 0;
      state.channel = 0;
      await analyzeCurrent();
    }
  } catch {}

  // Focus canvas for keys
  canvas.focus();
});

// Re-render on language change? Simple reload
