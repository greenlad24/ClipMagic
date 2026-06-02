export type CameraKeyframe = {
  t: number;    // 0–1 (percentage through shot)
  zoom: number; // 1.0 = no zoom
  panX: number; // -0.2 to 0.2
  panY: number; // -0.2 to 0.2
};

export type TimelineShot = {
  id: string;
  caption?: string;
  shotType?: string;
  beat?: string;
  beatCount?: number;
  startTime?: number;
  endTime?: number;
  targetUrl?: string;
  targetSelector?: string;
  transitionIn?: string;
  sfxIn?: string;
  clipUrl?: string;
  captureStatus?: string;
  uiLabelsJson?: string;
  visualIntent?: string;
};

export type SubtitleWord = { text: string; start: number; end: number; emphasis: boolean };
export type SubtitleEvent = {
  start: number;
  end: number;
  words: SubtitleWord[];
  placement?: string;
  lines?: number;
};

export type TemplateShot = {
  shotType: string;
  beat: string;
  startRatio: number; // 0–1 fraction of total duration
  endRatio: number;   // 0–1 fraction of total duration
  transitionIn?: string;
  sfxIn?: string;
  cameraPreset?: string;
  captionPlaceholder?: string;
  veo3Prompt?: string;
};

export type TimelineTemplate = {
  name: string;
  version: string;
  description?: string;
  shots: TemplateShot[];
};
