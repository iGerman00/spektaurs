import { GAP } from "./types";
import { t } from "./i18n";

export type Position = "top" | "bottom" | "left" | "right";

export class Ruler {
  x: number;
  y: number;
  pos: Position;
  sampleLabel: string;
  factors: number[];
  minUnits: number;
  maxUnits: number;
  spacing: number;
  scale: number;
  offset: number;
  formatter: (unit: number) => string;

  constructor(
    x: number,
    y: number,
    pos: Position,
    sampleLabel: string,
    factors: number[],
    minUnits: number,
    maxUnits: number,
    spacing: number,
    scale: number,
    offset: number,
    formatter: (unit: number) => string
  ) {
    this.x = x;
    this.y = y;
    this.pos = pos;
    this.sampleLabel = sampleLabel;
    this.factors = factors;
    this.minUnits = minUnits;
    this.maxUnits = maxUnits;
    this.spacing = spacing;
    this.scale = scale;
    this.offset = offset;
    this.formatter = formatter;
  }

  draw(c: CanvasRenderingContext2D) {
    c.save();
    c.font = "11px sans-serif";
    c.fillStyle = "#aaa";
    c.strokeStyle = "#888";
    c.lineWidth = 1;

    // Measure the sample label
    const metrics = c.measureText(this.sampleLabel);
    const len = this.pos === "top" || this.pos === "bottom" ? metrics.width : 12;

    // Select the factor to use, we want some space between the labels
    let factor = 0;
    for (const f of this.factors) {
      if (Math.abs(this.scale * f) >= this.spacing * len) {
        factor = f;
        break;
      }
    }

    // Draw the boundary ticks
    this.drawTick(c, this.minUnits);
    this.drawTick(c, this.maxUnits);

    if (factor > 0) {
      for (let tick = this.minUnits + factor; tick < this.maxUnits; tick += factor) {
        if (Math.abs(this.scale * (this.maxUnits - tick)) < len * 1.2) {
          break;
        }
        this.drawTick(c, tick);
      }
    }
    c.restore();
  }

  private drawTick(c: CanvasRenderingContext2D, tick: number) {
    const TICK_LEN = 4;
    const label = this.formatter(tick);
    const value =
      this.pos === "top" || this.pos === "bottom"
        ? tick
        : this.maxUnits + this.minUnits - tick;
    const p = Math.round(this.offset + this.scale * (value - this.minUnits));

    if (this.pos === "bottom") {
      c.textAlign = "center";
      c.textBaseline = "top";
      c.fillText(label, this.x + p, this.y + GAP);
      c.beginPath();
      c.moveTo(this.x + p + 0.5, this.y);
      c.lineTo(this.x + p + 0.5, this.y + TICK_LEN);
      c.stroke();
    } else if (this.pos === "left") {
      c.textAlign = "right";
      c.textBaseline = "middle";
      c.fillText(label, this.x - GAP, this.y + p);
      c.beginPath();
      c.moveTo(this.x, this.y + p + 0.5);
      c.lineTo(this.x - TICK_LEN, this.y + p + 0.5);
      c.stroke();
    } else if (this.pos === "right") {
      c.textAlign = "left";
      c.textBaseline = "middle";
      c.fillText(label, this.x + GAP, this.y + p);
      c.beginPath();
      c.moveTo(this.x, this.y + p + 0.5);
      c.lineTo(this.x + TICK_LEN, this.y + p + 0.5);
      c.stroke();
    } else if (this.pos === "top") {
      c.textAlign = "center";
      c.textBaseline = "bottom";
      c.fillText(label, this.x + p, this.y - GAP);
      c.beginPath();
      c.moveTo(this.x + p + 0.5, this.y);
      c.lineTo(this.x + p + 0.5, this.y - TICK_LEN);
      c.stroke();
    }
  }
}

export const timeFactors = [1, 2, 5, 10, 15, 30, 60, 2 * 60, 5 * 60, 10 * 60, 15 * 60, 30 * 60, 60 * 60];
export const freqFactors = [1000, 2000, 5000, 10000, 20000];
export const densityFactors = [1, 2, 5, 10, 20, 50];

export function timeFormatter(unit: number): string {
  const m = Math.floor(unit / 60);
  const s = Math.floor(unit % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export function freqFormatter(unit: number): string {
  const pat = t("%d kHz");
  return pat.replace("%d", String(Math.round(unit / 1000)));
}

export function densityFormatter(unit: number): string {
  const pat = t("%d dB");
  return pat.replace("%d", String(Math.round(-unit)));
}
