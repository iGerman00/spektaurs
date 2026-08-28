import { Palette } from "./types";

export function paletteColor(palette: Palette, level: number): number {
  const l = Math.max(0.0, Math.min(1.0, level));
  switch (palette) {
    case "spectrum":
      return spectrumColor(l);
    case "sox":
      return soxColor(l);
    case "mono":
      return monoColor(l);
  }
}

// Dan Bruton's algorithm (from spek-palette.cc)
function spectrumColor(level: number): number {
  const l = level * 0.6625;
  let r = 0.0, g = 0.0, b = 0.0;
  if (l >= 0.0 && l < 0.15) {
    r = (0.15 - l) / (0.15 + 0.075);
    g = 0.0;
    b = 1.0;
  } else if (l >= 0.15 && l < 0.275) {
    r = 0.0;
    g = (l - 0.15) / (0.275 - 0.15);
    b = 1.0;
  } else if (l >= 0.275 && l < 0.325) {
    r = 0.0;
    g = 1.0;
    b = (0.325 - l) / (0.325 - 0.275);
  } else if (l >= 0.325 && l < 0.5) {
    r = (l - 0.325) / (0.5 - 0.325);
    g = 1.0;
    b = 0.0;
  } else if (l >= 0.5 && l < 0.6625) {
    r = 1.0;
    g = (0.6625 - l) / (0.6625 - 0.5);
    b = 0.0;
  }

  // Intensity correction
  let cf = 1.0;
  if (l >= 0.0 && l < 0.1) {
    cf = l / 0.1;
  }
  cf *= 255.0;

  const rr = Math.floor(r * cf + 0.5);
  const gg = Math.floor(g * cf + 0.5);
  const bb = Math.floor(b * cf + 0.5);
  return (rr << 16) | (gg << 8) | bb;
}

// Rob Sykes' SoX palette (from spek-palette.cc)
function soxColor(level: number): number {
  let r = 0.0;
  if (level >= 0.13 && level < 0.73) {
    r = Math.sin(((level - 0.13) / 0.60) * Math.PI / 2.0);
  } else if (level >= 0.73) {
    r = 1.0;
  }

  let g = 0.0;
  if (level >= 0.60 && level < 0.91) {
    g = Math.sin(((level - 0.60) / 0.31) * Math.PI / 2.0);
  } else if (level >= 0.91) {
    g = 1.0;
  }

  let b = 0.0;
  if (level < 0.60) {
    b = 0.5 * Math.sin((level / 0.60) * Math.PI);
  } else if (level >= 0.78) {
    b = (level - 0.78) / 0.22;
  }

  const rr = Math.floor(r * 255.0 + 0.5);
  const gg = Math.floor(g * 255.0 + 0.5);
  const bb = Math.floor(b * 255.0 + 0.5);
  return (rr << 16) | (gg << 8) | bb;
}

function monoColor(level: number): number {
  const v = Math.floor(level * 255.0 + 0.5);
  return (v << 16) | (v << 8) | v;
}

export function generatePaletteLUT(palette: Palette, size = 1024): Uint32Array {
  const lut = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    const level = i / (size - 1);
    const rgb = paletteColor(palette, level);
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = rgb & 0xff;
    // ABGR 32-bit pixel for little-endian Uint32Array ImageData
    lut[i] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  return lut;
}

export function generateRemapLUT(palette: Palette, lrange: number, urange: number): Uint32Array {
  const remap = new Uint32Array(256);
  const palLut = generatePaletteLUT(palette, 1024);
  const range = urange - lrange;

  remap[0] = 0xff000000; // Silence / null is black

  for (let b = 1; b <= 255; b++) {
    const db = ((b - 1) / 254.0) * 140.0 - 140.0;
    const clamped = Math.max(lrange, Math.min(urange, db));
    const level = range === 0 ? 0 : (clamped - lrange) / range;
    const lutIdx = Math.max(0, Math.min(1023, Math.floor(level * 1023.0)));
    remap[b] = palLut[lutIdx];
  }
  return remap;
}
