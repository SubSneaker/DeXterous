import type { DexSettings } from "./types";

export type PresetId = "best" | "balanced" | "light";
/** What the picture-quality chips can show: a preset, or the user's own mix. */
export type QualityChoice = PresetId | "custom";

/** The settings a preset controls. Everything else in DexSettings stays as the user set it. */
export type QualitySettings = Pick<DexSettings, "resolutionScale" | "videoCodec" | "videoBitRate" | "maxFps">;

type CodecCheck = (codec: DexSettings["videoCodec"]) => boolean;

interface PresetDefinition {
  id: PresetId;
  label: string;
  /** One short line about when to use it. */
  summary: string;
  values: QualitySettings;
}

export const PRESETS: readonly PresetDefinition[] = [
  {
    id: "best",
    label: "Best (USB)",
    summary: "The sharpest picture. Meant for a USB cable.",
    values: { resolutionScale: 2, videoCodec: "h265", videoBitRate: 24, maxFps: 60 },
  },
  {
    id: "balanced",
    label: "Balanced (Wi‑Fi)",
    summary: "A good picture that a normal Wi‑Fi connection can keep up with.",
    values: { resolutionScale: 1.5, videoCodec: "h264", videoBitRate: 8, maxFps: 60 },
  },
  {
    id: "light",
    label: "Light",
    summary: "Smaller and smoother on slow Wi‑Fi or an older computer.",
    values: { resolutionScale: 1, videoCodec: "h264", videoBitRate: 4, maxFps: 30 },
  },
];

export const CUSTOM_SUMMARY = "Your own mix of the settings below.";

/** A preset's settings, with H.265 swapped for H.264 when this browser can't decode it. */
export function presetValues(id: PresetId, supportsCodec: CodecCheck): QualitySettings {
  const preset = PRESETS.find((candidate) => candidate.id === id)!;
  const { videoCodec } = preset.values;
  return { ...preset.values, videoCodec: supportsCodec(videoCodec) ? videoCodec : "h264" };
}

/** Which preset the settings add up to, or "custom". */
export function matchPreset(settings: QualitySettings, supportsCodec: CodecCheck): QualityChoice {
  for (const preset of PRESETS) {
    const values = presetValues(preset.id, supportsCodec);
    if (
      values.resolutionScale === settings.resolutionScale &&
      values.videoCodec === settings.videoCodec &&
      values.videoBitRate === settings.videoBitRate &&
      values.maxFps === settings.maxFps
    ) {
      return preset.id;
    }
  }
  return "custom";
}

/** "2× sharpness · H.265 · 24 Mbps · 60 fps" */
export function describeQuality(values: QualitySettings): string {
  const codec = { h264: "H.264", h265: "H.265", av1: "AV1" }[values.videoCodec];
  return `${values.resolutionScale}× sharpness · ${codec} · ${values.videoBitRate} Mbps · ${values.maxFps} fps`;
}
