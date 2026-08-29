import { State, WindowFn, Palette, MIN_RANGE, MAX_RANGE, MIN_FFT_BITS, MAX_FFT_BITS } from "./types";

export interface ControlActions {
  onAnalyze: () => void;
  onRecolor: () => void;
  onResetRange: () => void;
  onOpenPreferences: () => void;
  onOpenAbout: () => void;
  onSaveImage: () => void;
  onOpenFile: () => void;
  onCloseWindow: () => void;
}

export function setupKeyboardHandlers(state: State, actions: ControlActions) {
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const isMod = e.ctrlKey || e.metaKey;

    // ── Modifier key combinations (Ctrl / Cmd) ──
    if (isMod) {
      if (e.key === "," || e.key === "Preferences") {
        e.preventDefault();
        actions.onOpenPreferences();
        return;
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        actions.onSaveImage();
        return;
      }
      if (e.key === "o" || e.key === "O" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        actions.onOpenFile();
        return;
      }
      if (e.key === "w" || e.key === "W" || e.key === "q" || e.key === "Q") {
        e.preventDefault();
        actions.onCloseWindow();
        return;
      }
      return;
    }

    // Ignore when inside input/select elements
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    // ── Single-key shortcuts (matching original Spek) ──
    let handled = true;
    switch (e.key) {
      case "c":
        if (state.channels) {
          state.channel = (state.channel + 1) % state.channels;
          actions.onAnalyze();
        }
        break;
      case "C":
        if (state.channels) {
          state.channel = (state.channel - 1 + state.channels) % state.channels;
          actions.onAnalyze();
        }
        break;
      case "f": {
        const o: WindowFn[] = ["hann", "hamming", "blackman-harris"];
        const i = o.indexOf(state.windowFunction);
        state.windowFunction = o[(i + 1) % o.length];
        actions.onAnalyze();
        break;
      }
      case "F": {
        const o: WindowFn[] = ["hann", "hamming", "blackman-harris"];
        const i = o.indexOf(state.windowFunction);
        state.windowFunction = o[(i - 1 + o.length) % o.length];
        actions.onAnalyze();
        break;
      }
      case "l":
        state.lrange = Math.min(state.lrange + 1, state.urange - 1);
        actions.onRecolor();
        break;
      case "L":
        state.lrange = Math.max(state.lrange - 1, MIN_RANGE);
        actions.onRecolor();
        break;
      case "p": {
        const o: Palette[] = ["sox", "spectrum", "mono"];
        const i = o.indexOf(state.palette);
        state.palette = o[(i + 1) % o.length];
        actions.onRecolor();
        break;
      }
      case "P": {
        const o: Palette[] = ["sox", "spectrum", "mono"];
        const i = o.indexOf(state.palette);
        state.palette = o[(i - 1 + o.length) % o.length];
        actions.onRecolor();
        break;
      }
      case "s":
        if (state.streams) {
          state.stream = (state.stream + 1) % state.streams;
          actions.onAnalyze();
        }
        break;
      case "S":
        if (state.streams) {
          state.stream = (state.stream - 1 + state.streams) % state.streams;
          actions.onAnalyze();
        }
        break;
      case "u":
        state.urange = Math.min(state.urange + 1, MAX_RANGE);
        actions.onRecolor();
        break;
      case "U":
        state.urange = Math.max(state.urange - 1, state.lrange + 1);
        actions.onRecolor();
        break;
      case "w":
        state.fftBits = Math.min(state.fftBits + 1, MAX_FFT_BITS);
        actions.onAnalyze();
        break;
      case "W":
        state.fftBits = Math.max(state.fftBits - 1, MIN_FFT_BITS);
        actions.onAnalyze();
        break;
      case "r":
      case "R":
        actions.onResetRange();
        break;
      case "F1":
        if (e.shiftKey) actions.onOpenAbout();
        else actions.onOpenPreferences();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
    }
  });
}

export function setupMouseWheelHandlers(
  container: HTMLElement,
  state: State,
  onRecolor: () => void
) {
  container.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      const dir = delta < 0 ? 1 : -1;
      const step = e.altKey ? 5 : Math.abs(delta) > 50 ? 2 : 1;

      if (e.shiftKey) {
        // Shift + Wheel: Adjust High Range
        if (dir > 0) {
          state.urange = Math.min(state.urange + step, MAX_RANGE);
        } else {
          state.urange = Math.max(state.urange - step, state.lrange + 1);
        }
      } else {
        // Wheel: Adjust Low Range
        if (dir > 0) {
          state.lrange = Math.min(state.lrange + step, state.urange - 1);
        } else {
          state.lrange = Math.max(state.lrange - step, MIN_RANGE);
        }
      }
      onRecolor();
    },
    { passive: false }
  );
}

export function setupMiddleClickReset(container: HTMLElement, onReset: () => void) {
  container.addEventListener("auxclick", (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onReset();
    }
  });
}
