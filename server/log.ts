// Minimal console logger for the relay. Colors are applied with
// `util.styleText`, which automatically drops them when the stream is not a
// TTY or when NO_COLOR / NODE_DISABLE_COLORS is set.
import { styleText, type InspectColor } from "node:util";

let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function isVerbose(): boolean {
  return verboseEnabled;
}

/** Styles text for stdout (no-op when stdout is not a color terminal). */
export function paint(format: InspectColor | InspectColor[], text: string): string {
  return styleText(format, text, { stream: process.stdout });
}

function paintError(format: InspectColor, text: string): string {
  return styleText(format, text, { stream: process.stderr });
}

export const log = {
  info(message: string): void {
    console.log(message);
  },
  warn(message: string): void {
    console.warn(paintError("yellow", `warning: ${message}`));
  },
  error(message: string): void {
    console.error(paintError("red", `error: ${message}`));
  },
  /** Only printed with `--verbose`. */
  debug(message: string): void {
    if (verboseEnabled) {
      console.log(paint("gray", `[${new Date().toISOString()}] ${message}`));
    }
  },
};
