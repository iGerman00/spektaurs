import { Palette } from "./types";

export function paletteColor(palette: Palette, level: number): number {
  const l = Math.max(0.0, Math.min(1.0, level));
  switch (palette) {
    case "sox":
      return soxColor(l);
    case "spectrum":
      return spectrumColor(l);
    case "mono":
      return monoColor(l);
  }
}

function soxColor(level: number): number {
  if (level <= 0.0) return 0x000000;
  if (level >= 1.0) return 0xffffff;
  const l = level * 5.0;
  const i = Math.floor(l);
  const r = l - i;
  let rr = 0, gg = 0, bb = 0;
  switch (i) {
    case 0: bb = Math.min(1.0, 4.0 * r); break;
    case 1: rr = Math.min(1.0, 2.0 * r); bb = 1.0 - 0.5 * r; break;
    case 2: rr = 1.0; bb = 0.5 * (1.0 - r); break;
    case 3: rr = 1.0; gg = r; break;
    case 4: rr = 1.0; gg = 1.0; bb = r; break;
    default: rr = 1.0; gg = 1.0; bb = 1.0; break;
  }
  const r_byte = Math.floor(rr * 255.0 + 0.5);
  const g_byte = Math.floor(gg * 255.0 + 0.5);
  const b_byte = Math.floor(bb * 255.0 + 0.5);
  return (r_byte << 16) | (g_byte << 8) | b_byte;
}

function spectrumColor(level: number): number {
  if (level <= 0.0 || level >= 1.0) return 0x000000;
  let r = 0, g = 0, b = 0;
  if (level >= 0.13 && level < 0.73) r = Math.sin(((level - 0.13) / 0.60) * Math.PI);
  if (level >= 0.60 && level < 0.91) g = Math.sin(((level - 0.60) / 0.31) * Math.PI);
  else if (level >= 0.91) g = (level - 0.91) / 0.09;
  if (level < 0.60) b = 0.5 * Math.sin((level / 0.60) * Math.PI);
  else if (level >= 0.78) b = (level - 0.78) / 0.22;

  const r_byte = Math.floor(r * 255.0 + 0.5);
  const g_byte = Math.floor(g * 255.0 + 0.5);
  const b_byte = Math.floor(b * 255.0 + 0.5);
  return (r_byte << 16) | (g_byte << 8) | b_byte;
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
