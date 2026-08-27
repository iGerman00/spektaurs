import { RULER, GAP } from "./types";

export type Position = "bottom" | "left" | "right";

export class Ruler {
  x: number;
  y: number;
  pos: Position;
  sample: string;
  factors: number[];
  minVal: number;
  maxVal: number;
  unit: number;
  scale: number;
  length: number;
  formatter: (val: number, step: number) => string;

  constructor(
    x: number,
    y: number,
    pos: Position,
    sample: string,
    factors: number[],
    minVal: number,
    maxVal: number,
    unit: number,
    scale: number,
    length: number,
    formatter: (val: number, step: number) => string
  ) {
    this.x = x;
    this.y = y;
    this.pos = pos;
    this.sample = sample;
    this.factors = factors;
    this.minVal = minVal;
    this.maxVal = maxVal;
    this.unit = unit;
    this.scale = scale;
    this.length = length;
    this.formatter = formatter;
  }

  draw(c: CanvasRenderingContext2D) {
    if (this.length <= 0) return;
    c.save();
    c.font = "11px sans-serif";
    c.fillStyle = "#888";
    c.strokeStyle = "#444";
    c.lineWidth = 1;

    let textLen = 0;
    if (this.pos === "bottom") {
      textLen = c.measureText(this.sample).width;
    } else {
      textLen = 14;
    }

    let factor = 0;
    for (const f of this.factors) {
      factor = f;
      const cnt = Math.abs((this.maxVal - this.minVal) / (f * this.unit));
      const textUnits = textLen * cnt;
      if (textUnits <= this.length) {
        break;
      }
    }

    const step = factor * this.unit;
    if (step <= 0) {
      c.restore();
      return;
    }

    const first = Math.ceil(this.minVal / step);
    const last = Math.floor(this.maxVal / step);

    for (let i = first; i <= last; i++) {
      const val = i * step;
      const pos = Math.round(this.scale * (val - this.minVal));
      if (pos < 0 || pos > this.length) continue;

      let tickX = 0, tickY = 0, endX = 0, endY = 0;
      let textX = 0, textY = 0;
      let align: CanvasTextAlign = "center";
      let baseline: CanvasTextBaseline = "middle";

      const tickLen = Math.round(RULER * 0.4);

      if (this.pos === "bottom") {
        tickX = this.x + pos;
        tickY = this.y;
        endX = tickX;
        endY = tickY + tickLen;
        textX = tickX;
        textY = this.y + RULER + 2;
        align = "center";
        baseline = "top";
      } else if (this.pos === "left") {
        tickX = this.x;
        tickY = this.y + pos;
        endX = tickX - tickLen;
        endY = tickY;
        textX = this.x - GAP - RULER;
        textY = tickY;
        align = "right";
        baseline = "middle";
      } else if (this.pos === "right") {
        tickX = this.x;
        tickY = this.y + pos;
        endX = tickX + tickLen;
        endY = tickY;
        textX = this.x + RULER + GAP;
        textY = tickY;
        align = "left";
        baseline = "middle";
      }

      // Draw tick line
      c.beginPath();
      c.moveTo(tickX + 0.5, tickY + 0.5);
      c.lineTo(endX + 0.5, endY + 0.5);
      c.stroke();

      // Draw label
      c.textAlign = align;
      c.textBaseline = baseline;
      const label = this.formatter(val, step);
      c.fillText(label, textX, textY);
    }
    c.restore();
  }
}

export const timeFactors = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
export const freqFactors = [1000, 2000, 5000, 10000, 20000];
export const densityFactors = [1, 2, 5, 10, 20, 50];

export function timeFormatter(val: number): string {
  const totalSec = Math.round(Math.max(0, val));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
  }
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export function freqFormatter(val: number): string {
  return `${Math.round(val / 1000)} kHz`;
}

export function densityFormatter(val: number): string {
  return `${Math.round(-val)} dB`;
}
