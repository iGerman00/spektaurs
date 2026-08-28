import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  State,
  SpectrogramResult,
  ProgressBatchPayload,
  LPAD,
  TPAD,
  RPAD,
  BPAD,
  LRANGE_DEFAULT,
  URANGE_DEFAULT,
  RULER,
} from "./types";
import { t, setLanguage, applyI18n } from "./i18n";
import { generatePaletteLUT, generateRemapLUT } from "./palette";
import { downsampleColumnToDisplay, renderScene } from "./renderer";
import { openPreferences, openAbout, showToast } from "./dialogs";
import { setupKeyboardHandlers, setupMouseWheelHandlers, setupMiddleClickReset } from "./controls";

// ── Application State ──
const state: State = {
  path: "",
  stream: 0,
  channel: 0,
  windowFunction: "hann",
  fftBits: 11,
  palette: "sox",
  lrange: LRANGE_DEFAULT,
  urange: URANGE_DEFAULT,
  sampleRate: 0,
  duration: 0,
  codecName: "",
  bitRate: 0,
  bitsPerSample: 0,
  channels: 0,
  streams: 0,
  desc: "",
  samples: 0,
  bands: 0,
  displayHeight: 0,
};

let rawQuantized: Uint8Array | null = null;
let currentRemapLUT = generateRemapLUT(state.palette, state.lrange, state.urange);

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let container: HTMLElement;
let loadingEl: HTMLElement;
let loadingText: HTMLElement | null;
let infoBar: HTMLElement;
let hintEl: HTMLElement;

let offscreen: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let offscreenImageData: ImageData | null = null;
let offscreenData32: Uint32Array | null = null;
let offscreenDirty = false;

let paletteCanvas: HTMLCanvasElement | null = null;
let paletteCtx: CanvasRenderingContext2D | null = null;
let paletteImageData: ImageData | null = null;
let paletteData32: Uint32Array | null = null;

let generation = 0;
let cachedKey = "";
let lastCanvasW = 0;
let lastCanvasH = 0;

// ── Offscreen Buffers ──
function ensureOffscreen(samples: number, displayHeight: number, keepContent = true) {
  if (offscreen && offscreen.width === samples && offscreen.height === displayHeight) {
    if (!keepContent && offscreenData32) {
      offscreenData32.fill(0xff000000);
      if (offscreenCtx && offscreenImageData) {
        offscreenCtx.putImageData(offscreenImageData, 0, 0);
      }
    }
    return;
  }

  const oldOffscreen = offscreen;
  offscreen = document.createElement("canvas");
  offscreen.width = samples;
  offscreen.height = displayHeight;
  offscreenCtx = offscreen.getContext("2d", { willReadFrequently: true });
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
    } else if (offscreenData32) {
      offscreenData32.fill(0xff000000);
    }
  }
}

function ensurePaletteStrip(imgH: number) {
  const palW = RULER;
  if (!paletteCanvas || paletteCanvas.height !== imgH || paletteCanvas.width !== palW) {
    paletteCanvas = document.createElement("canvas");
    paletteCanvas.width = palW;
    paletteCanvas.height = imgH;
    paletteCtx = paletteCanvas.getContext("2d");
    paletteImageData = paletteCtx ? paletteCtx.createImageData(palW, imgH) : null;
    paletteData32 = paletteImageData ? new Uint32Array(paletteImageData.data.buffer) : null;
  }
  if (!paletteData32 || !paletteCtx || !paletteImageData) return;

  const palLut = generatePaletteLUT(state.palette, 1024);
  for (let y = 0; y < imgH; y++) {
    const level = 1.0 - (imgH > 1 ? y / (imgH - 1) : 0);
    const lutIdx = Math.max(0, Math.min(1023, Math.floor(level * 1023.0)));
    const color = palLut[lutIdx];
    for (let x = 0; x < palW; x++) {
      paletteData32[y * palW + x] = color;
    }
  }
  paletteCtx.putImageData(paletteImageData, 0, 0);
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

  const bands = state.bands;
  const samples = state.samples;
  currentRemapLUT = generateRemapLUT(state.palette, state.lrange, state.urange);

  if (rawQuantized && rawQuantized.length === samples * bands) {
    const d32 = offscreenData32;
    const raw = rawQuantized;
    const remap = currentRemapLUT;
    for (let x = 0; x < samples; x++) {
      downsampleColumnToDisplay(raw, x * bands, bands, displayHeight, d32, x, samples, remap);
    }
    offscreenCtx.putImageData(offscreenImageData, 0, 0);
    offscreenDirty = false;
  }
}

// ── Rendering Loop ──
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
  const cw = width * dpr;
  const ch = height * dpr;

  if (cw !== lastCanvasW || ch !== lastCanvasH) {
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    lastCanvasW = cw;
    lastCanvasH = ch;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const imgH = Math.max(1, Math.floor(height - TPAD - BPAD));
  ensurePaletteStrip(imgH);

  renderScene(ctx, width, height, state, offscreen, paletteCanvas);

  // Update top tooltip position
  const tip = document.getElementById("top-bar-tooltip");
  if (tip) {
    tip.title = state.desc ? `${state.desc}` : "";
  }
}

let recolorRafPending = false;
function scheduleRecolor() {
  currentRemapLUT = generateRemapLUT(state.palette, state.lrange, state.urange);
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

// ── Audio Analysis Pipeline ──
async function analyzeCurrent() {
  if (!state.path) {
    render();
    return;
  }

  const rect = container.getBoundingClientRect();
  const availW = Math.max(1, Math.floor(rect.width - LPAD - RPAD));
  const samples = availW;
  const displayHeight = Math.max(1, Math.floor(rect.height - TPAD - BPAD));
  state.displayHeight = displayHeight;

  const key = `${state.path}|${state.stream}|${state.channel}|${state.windowFunction}|${state.fftBits}|${samples}`;
  if (key === cachedKey) {
    render();
    return;
  }
  cachedKey = key;

  const myGen = ++generation;
  try {
    await invoke("cancel_pipeline");
  } catch {}

  const bands = (1 << state.fftBits) / 2 + 1;
  state.bands = bands;
  state.samples = samples;

  let showPreview = true;
  try {
    const prefs: any = await invoke("get_default_settings");
    if (prefs && prefs.show_preview !== undefined) {
      showPreview = prefs.show_preview !== false;
    }
  } catch {}

  ensureOffscreen(samples, displayHeight, showPreview);
  rawQuantized = new Uint8Array(samples * bands);
  currentRemapLUT = generateRemapLUT(state.palette, state.lrange, state.urange);

  loadingEl.classList.remove("hidden");
  if (loadingText) loadingText.textContent = t("Analysing…");
  render();

  let rafScheduled = false;
  let unlisten: (() => void) | null = null;
  let unlistenDecode: (() => void) | null = null;
  let renderedSample = 0;
  let receivedSample = 0;

  const win = getCurrentWindow();

  try {
    unlistenDecode = await win.listen<number>("spectrogram-decode-progress", (ev) => {
      if (myGen !== generation) return;
      const p = ev.payload;
      if (loadingText) {
        loadingText.textContent = p > 0 ? `${t("Decoding…")} ${p}%` : t("Decoding…");
      }
    });
  } catch {}

  if (showPreview) {
    try {
      unlisten = await win.listen<ProgressBatchPayload>("spectrogram-progress-batch", (ev) => {
        if (myGen !== generation) return;
        const p = ev.payload;
        if (p.bands !== bands || !offscreenData32 || !rawQuantized) return;

        rawQuantized.set(p.data_u8, p.start_sample * bands);
        receivedSample = Math.max(receivedSample, p.start_sample + p.count);

        if (!rafScheduled || receivedSample >= samples) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            if (myGen !== generation || !offscreenData32 || !rawQuantized) return;
            const target = Math.min(samples, receivedSample);
            while (renderedSample < target) {
              downsampleColumnToDisplay(
                rawQuantized,
                renderedSample * bands,
                bands,
                displayHeight,
                offscreenData32,
                renderedSample,
                samples,
                currentRemapLUT
              );
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

    if (myGen !== generation) return;

    state.sampleRate = result.sample_rate;
    state.duration = result.duration;
    state.codecName = result.codec_name;
    state.bitRate = result.bit_rate;
    state.bitsPerSample = result.bits_per_sample;
    state.channels = result.channels;
    state.streams = result.streams;
    state.desc = result.desc;
    state.error = result.error;
    state.bands = result.bands;
    state.samples = result.samples;
    state.displayHeight = displayHeight;

    if (result.magnitudes && result.magnitudes.length === samples * bands) {
      if (!rawQuantized || rawQuantized.length !== samples * bands) {
        rawQuantized = new Uint8Array(samples * bands);
      }
      for (let i = 0; i < samples * bands; i++) {
        const v = result.magnitudes[i];
        if (v === null || v === undefined || typeof v !== "number" || !isFinite(v) || v <= -140.0) {
          rawQuantized[i] = 0;
        } else {
          rawQuantized[i] = Math.max(1, Math.min(255, Math.floor(((Math.min(0, v) + 140.0) / 140.0) * 254.0) + 1));
        }
      }
    }

    rebuildOffscreenFromState();
  } catch (e: any) {
    if (myGen === generation) {
      state.error = String(e);
    }
  } finally {
    if (unlisten) unlisten();
    if (unlistenDecode) unlistenDecode();
    if (myGen === generation) {
      loadingEl.classList.add("hidden");
      render();
    }
  }
}

// ── File Operations ──
async function openFile(path: string) {
  state.path = path;
  state.stream = 0;
  state.channel = 0;
  cachedKey = "";
  await analyzeCurrent();
}

async function openFileDialog() {
  const selected = await openDialog({
    multiple: false,
    filters: [
      {
        name: "Audio Files",
        extensions: ["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "wma", "ape", "wv", "ac3", "dts", "aiff", "mpc"],
      },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (selected) {
    const filePath = typeof selected === "string" ? selected : (selected as any).path;
    if (filePath) {
      await openFile(filePath);
    }
  }
}

async function saveSpectrogram() {
  if (!state.path) return;
  const defaultName = (state.path.split(/[/\\]/).pop() || "audio").replace(/\.[^/.]+$/, "") + ".png";
  const selected = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: "PNG Images", extensions: ["png"] }],
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
      renderScene(expCtx, saveW, saveH, state, offscreen, paletteCanvas);
      state.displayHeight = origDisplayH;
      rebuildOffscreenFromState();
    } else {
      renderScene(expCtx, saveW, saveH, state, offscreen, paletteCanvas);
    }
  }

  const dataUrl = exportCanvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1];
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

  try {
    await writeFile(selected, bytes);
    showToast("Saved to " + selected);
  } catch {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = selected.split(/[/\\]/).pop() || "spectrogram.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast("Saved (download)");
  }
}

async function resetDynamicRange() {
  try {
    const def: any = await invoke("get_default_settings");
    state.lrange = typeof def.lrange === "number" ? def.lrange : LRANGE_DEFAULT;
    state.urange = typeof def.urange === "number" ? def.urange : URANGE_DEFAULT;
  } catch {
    state.lrange = LRANGE_DEFAULT;
    state.urange = URANGE_DEFAULT;
  }
  scheduleRecolor();
  showToast(`Range reset: ${state.lrange} dB to ${state.urange} dB`);
}

// ── Application Initialization ──
window.addEventListener("DOMContentLoaded", async () => {
  canvas = document.getElementById("spectrogram") as HTMLCanvasElement;
  ctx = canvas.getContext("2d")!;
  container = document.getElementById("canvas-container") as HTMLElement;
  loadingEl = document.getElementById("loading") as HTMLElement;
  loadingText = loadingEl.querySelector("span");
  infoBar = document.getElementById("info-bar") as HTMLElement;
  hintEl = document.getElementById("hint") as HTMLElement;

  // Initialize Language & Preferences
  try {
    const curLang: string = (await invoke("get_language")) || "en";
    setLanguage(curLang);
  } catch {}

  try {
    const def: any = await invoke("get_default_settings");
    if (def.window_function) state.windowFunction = def.window_function;
    if (def.fft_bits) state.fftBits = def.fft_bits;
    if (def.palette) state.palette = def.palette;
    if (typeof def.lrange === "number") state.lrange = def.lrange;
    if (typeof def.urange === "number") state.urange = def.urange;
    if (def.show_shortcuts !== undefined && hintEl) {
      hintEl.classList.toggle("hidden", def.show_shortcuts === false);
      render();
    }
  } catch {}

  applyI18n();

  // Setup Tooltip element
  if (!document.getElementById("top-bar-tooltip")) {
    const tip = document.createElement("div");
    tip.id = "top-bar-tooltip";
    tip.style.position = "absolute";
    tip.style.left = LPAD + "px";
    tip.style.top = TPAD - 2 * 10 - 20 + "px";
    tip.style.width = "calc(100% - " + (LPAD + RPAD) + "px)";
    tip.style.height = "20px";
    tip.style.pointerEvents = "auto";
    tip.style.zIndex = "5";
    container.appendChild(tip);
  }

  // Setup Menus
  document.querySelectorAll(".menu").forEach((menu) => {
    const title = menu.querySelector(".menu-title") as HTMLElement;
    title.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains("open");
      document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
      if (!isOpen) menu.classList.add("open");
    });
    menu.addEventListener("mouseenter", () => {
      if (document.querySelector(".menu.open") && !menu.classList.contains("open")) {
        document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
        menu.classList.add("open");
      }
    });
  });
  document.addEventListener("click", () => document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
  });

  // Action dispatcher
  const handleAction = (act: string) => {
    switch (act) {
      case "open": openFileDialog(); break;
      case "save": saveSpectrogram(); break;
      case "preferences": openPreferences(state, () => { rebuildOffscreenFromState(); render(); }, (show) => { if (hintEl) hintEl.classList.toggle("hidden", !show); render(); }); break;
      case "about": openAbout(); break;
      case "exit": getCurrentWindow().close(); break;
    }
  };

  document.querySelectorAll("[data-action]").forEach((el) =>
    el.addEventListener("click", (e) => {
      const act = (e.currentTarget as HTMLElement).getAttribute("data-action");
      if (act) handleAction(act);
      document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
    })
  );

  document.querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const url = (e.currentTarget as HTMLElement).getAttribute("data-open");
      if (url) openUrl(url);
    })
  );

  infoBar.addEventListener("click", () => openUrl("https://www.spek.cc"));
  document.getElementById("info-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    infoBar.classList.add("hidden");
  });

  // Setup Keyboard & Mouse Controls
  setupKeyboardHandlers(state, () => debouncedAnalyze(), () => scheduleRecolor(), () => resetDynamicRange(), () => openAbout());
  setupMouseWheelHandlers(container, state, () => debouncedAnalyze(100), () => scheduleRecolor());
  setupMiddleClickReset(container, () => resetDynamicRange());

  canvas.tabIndex = 0;
  canvas.focus();
  container.addEventListener("click", () => canvas.focus());

  // Window Resize Handling
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

  // Drag and Drop Handling
  const overlay = document.getElementById("drop-overlay") as HTMLElement;
  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    overlay.classList.remove("hidden");
  });
  container.addEventListener("dragleave", () => overlay.classList.add("hidden"));
  container.addEventListener("drop", async (e) => {
    e.preventDefault();
    overlay.classList.add("hidden");
    const files = e.dataTransfer?.files;
    if (files && files.length === 1) {
      const file = files[0];
      const filePath = (file as File & { path?: string }).path;
      if (filePath) {
        openFile(filePath);
      } else {
        showToast("Drop not supported in browser, use Open dialog");
      }
    }
  });

  try {
    const win = getCurrentWindow();
    win.onDragDropEvent((event) => {
      if (event.payload.type === "over") overlay.classList.remove("hidden");
      else if (event.payload.type === "drop") {
        overlay.classList.add("hidden");
        const paths = event.payload.paths;
        if (paths.length === 1) {
          openFile(paths[0]);
        }
      } else {
        overlay.classList.add("hidden");
      }
    });
  } catch {}

  // CLI Arguments (auto-open file from command line)
  try {
    const cli: any = await invoke("get_cli_args");
    if (cli.file) {
      await openFile(cli.file);
    }
  } catch {}

  // Update check
  try {
    const res: any = await invoke("check_version");
    if (res.update_available) infoBar.classList.remove("hidden");
  } catch {}

  render();
});
