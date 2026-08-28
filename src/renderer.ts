import { State, LPAD, TPAD, RPAD, BPAD, GAP, RULER } from "./types";
import { Ruler, timeFactors, freqFactors, densityFactors, timeFormatter, freqFormatter, densityFormatter } from "./ruler";
import { t } from "./i18n";

export function downsampleColumnToDisplay(
  raw: Uint8Array,
  colBase: number,
  bands: number,
  displayHeight: number,
  d32: Uint32Array,
  x: number,
  samples: number,
  remap: Uint32Array
) {
  if (bands <= 0 || displayHeight <= 0) return;

  for (let dy = 0; dy < displayHeight; dy++) {
    const srcTop = (1.0 - dy / displayHeight) * (bands - 1);
    const srcBot = (1.0 - (dy + 1) / displayHeight) * (bands - 1);

    const botIdx = Math.max(0, Math.floor(srcBot));
    const topIdx = Math.min(bands - 1, Math.ceil(srcTop));

    if (botIdx === topIdx) {
      d32[dy * samples + x] = remap[raw[colBase + botIdx]];
      continue;
    }

    let weightedSum = 0;
    let totalWeight = 0;

    for (let k = botIdx; k <= topIdx; k++) {
      const segStart = Math.max(srcBot, k - 0.5);
      const segEnd = Math.min(srcTop, k + 0.5);
      const weight = Math.max(0, segEnd - segStart);
      if (weight > 0) {
        weightedSum += raw[colBase + k] * weight;
        totalWeight += weight;
      }
    }

    const avg = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    d32[dy * samples + x] = remap[Math.max(0, Math.min(255, avg))];
  }
}

export function trimText(c: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (c.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid) + "…";
    if (c.measureText(candidate).width <= maxW) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return text.slice(0, Math.max(0, lo - 1)) + "…";
}

export function renderScene(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: State,
  offscreen: HTMLCanvasElement | null,
  paletteCanvas: HTMLCanvasElement | null
) {
  c.fillStyle = "#1e1e1e";
  c.fillRect(0, 0, w, h);

  const imgW = Math.max(0, w - LPAD - RPAD);
  const imgH = Math.max(0, h - TPAD - BPAD);

  // Top header text
  c.font = "12px sans-serif";
  c.fillStyle = "#eee";
  c.textAlign = "left";
  c.textBaseline = "alphabetic";

  const topTextW = Math.max(50, w - LPAD - RPAD - 90);
  const titleY = TPAD - 2 * GAP - 14;
  const descY = TPAD - GAP - 2;

  if (state.path) {
    const fileName = state.path.split(/[/\\]/).pop() || "";
    c.font = "bold 12px sans-serif";
    c.fillText(trimText(c, fileName, topTextW), LPAD, titleY);

    c.font = "11px sans-serif";
    c.fillStyle = "#bbb";
    const descText = state.error ? `Error: ${state.error}` : state.desc || "";
    c.fillText(trimText(c, descText, topTextW), LPAD, descY);
  }

  // App version badge (top right)
  c.font = "bold 11px sans-serif";
  c.fillStyle = "#888";
  c.textAlign = "right";
  c.fillText("Spektaurs 0.8.5", w - RPAD + GAP + RULER + 40, descY);

  if (imgW <= 0 || imgH <= 0) return;

  // Spectrogram plot area
  if (offscreen && offscreen.width > 0 && offscreen.height > 0) {
    c.imageSmoothingEnabled = false;
    c.drawImage(offscreen, Math.round(LPAD), Math.round(TPAD), imgW, imgH);
  } else {
    c.fillStyle = "#000";
    c.fillRect(LPAD, TPAD, imgW, imgH);
  }

  if (!state.path) {
    c.fillStyle = "#888";
    c.font = "14px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(t("Drop an audio file here or use File → Open"), LPAD + imgW / 2, TPAD + imgH / 2);
  }

  // Spectrogram border
  c.strokeStyle = "#444";
  c.lineWidth = 1;
  c.strokeRect(LPAD + 0.5, TPAD + 0.5, imgW, imgH);

  // Time Ruler (Bottom)
  if (state.duration > 0) {
    new Ruler(
      LPAD,
      TPAD + imgH,
      "bottom",
      "00:00",
      timeFactors,
      0,
      state.duration,
      1.0,
      imgW / state.duration,
      imgW,
      timeFormatter
    ).draw(c);
  }

  // Frequency Ruler (Left)
  if (state.sampleRate > 0) {
    const maxFreq = state.sampleRate / 2;
    new Ruler(
      LPAD,
      TPAD,
      "left",
      "00 kHz",
      freqFactors,
      maxFreq,
      0,
      1.0,
      -imgH / maxFreq,
      imgH,
      freqFormatter
    ).draw(c);
  }

  // Palette strip & Dynamic Range Ruler (Right)
  const palX = w - RPAD + GAP;
  const palW = RULER;

  if (paletteCanvas) {
    c.imageSmoothingEnabled = false;
    c.drawImage(paletteCanvas, Math.round(palX), Math.round(TPAD), palW, imgH);
  }
  c.strokeRect(palX + 0.5, TPAD + 0.5, palW, imgH);

  new Ruler(
    w - RPAD + GAP + RULER,
    TPAD,
    "right",
    "-00 dB",
    densityFactors,
    -state.urange,
    -state.lrange,
    3.0,
    imgH / (state.lrange - state.urange),
    imgH,
    densityFormatter
  ).draw(c);
}
