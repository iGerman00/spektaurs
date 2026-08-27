import { State, WindowFn, Palette, MIN_RANGE, MAX_RANGE, MIN_FFT_BITS, MAX_FFT_BITS } from "./types";

export function setupKeyboardHandlers(
  state: State,
  onAnalyze: () => void,
  onRecolor: () => void,
  onResetRange: () => void,
  onOpenAbout: () => void
) {
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    let handled = true;
    switch (e.key) {
      case "c":
        if (state.channels) {
          state.channel = (state.channel + 1) % state.channels;
          onAnalyze();
        }
        break;
      case "C":
        if (state.channels) {
          state.channel = (state.channel - 1 + state.channels) % state.channels;
          onAnalyze();
        }
        break;
      case "f": {
        const o: WindowFn[] = ["hann", "hamming", "blackman-harris"];
        const i = o.indexOf(state.windowFunction);
        state.windowFunction = o[(i + 1) % o.length];
        onAnalyze();
        break;
      }
      case "F": {
        const o: WindowFn[] = ["hann", "hamming", "blackman-harris"];
        const i = o.indexOf(state.windowFunction);
        state.windowFunction = o[(i - 1 + o.length) % o.length];
        onAnalyze();
        break;
      }
      case "l":
        state.lrange = Math.min(state.lrange + 1, state.urange - 1);
        onRecolor();
        break;
      case "L":
        state.lrange = Math.max(state.lrange - 1, MIN_RANGE);
        onRecolor();
        break;
      case "p": {
        const o: Palette[] = ["spectrum", "sox", "mono"];
        const i = o.indexOf(state.palette);
        state.palette = o[(i + 1) % o.length];
        onRecolor();
        break;
      }
      case "P": {
        const o: Palette[] = ["spectrum", "sox", "mono"];
        const i = o.indexOf(state.palette);
        state.palette = o[(i - 1 + o.length) % o.length];
        onRecolor();
        break;
      }
      case "s":
        if (state.streams) {
          state.stream = (state.stream + 1) % state.streams;
          onAnalyze();
        }
        break;
      case "S":
        if (state.streams) {
          state.stream = (state.stream - 1 + state.streams) % state.streams;
          onAnalyze();
        }
        break;
      case "u":
        state.urange = Math.min(state.urange + 1, MAX_RANGE);
        onRecolor();
        break;
      case "U":
        state.urange = Math.max(state.urange - 1, state.lrange + 1);
        onRecolor();
        break;
      case "w":
        state.fftBits = Math.min(state.fftBits + 1, MAX_FFT_BITS);
        onAnalyze();
        break;
      case "W":
        state.fftBits = Math.max(state.fftBits - 1, MIN_FFT_BITS);
        onAnalyze();
        break;
      case "r":
      case "R":
        onResetRange();
        break;
      case "F1":
        if (e.shiftKey) onOpenAbout();
        else window.open("https://help.spek.cc/man-0.8.5.html", "_blank");
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
  onAnalyze: () => void,
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

      if (e.ctrlKey) {
        if (dir > 0) {
          state.fftBits = Math.min(MAX_FFT_BITS, state.fftBits + 1);
        } else {
          state.fftBits = Math.max(MIN_FFT_BITS, state.fftBits - 1);
        }
        onAnalyze();
      } else if (e.shiftKey) {
        state.urange = Math.max(state.lrange + 1, Math.min(MAX_RANGE, state.urange + dir * step));
        onRecolor();
      } else {
        state.lrange = Math.max(MIN_RANGE, Math.min(state.urange - 1, state.lrange + dir * step));
        onRecolor();
      }
    },
    { passive: false }
  );
}

export function setupMiddleClickReset(container: HTMLElement, onResetRange: () => void) {
  const handler = (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onResetRange();
    }
  };
  container.addEventListener("auxclick", handler);
  container.addEventListener("mousedown", handler);
}
