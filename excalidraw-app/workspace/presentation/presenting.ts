/**
 * Intranet fork: what a presentation tells its helpers: the presenter
 * window (P3, same browser) and the phone remote (P4).
 */

/** where the presentation stands */
export interface PresentingState {
  index: number;
  count: number;
  /** clicks shown on this slide (P5) */
  step: number;
  steps: number;
  title: string;
  notes: string;
  nextTitle: string | null;
  /** epoch ms, for the timer */
  startedAt: number;
}

/** the presenter window also gets pictures */
export interface PresenterWindowState extends PresentingState {
  current: string | null;
  next: string | null;
}

/** what the helpers ask for */
export type PresentingCommand =
  | { type: "next" }
  | { type: "prev" }
  | { type: "hello" }
  | { type: "stop" };

export const presenterChannelName = (id: string) =>
  `excalidraw-presenter-${id}`;

/** text with its links clickable: [text, url?] parts */
export const linkParts = (text: string) => {
  const parts: { text: string; url?: string }[] = [];
  const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    if (match.index! > last) {
      parts.push({ text: text.slice(last, match.index) });
    }
    parts.push({ text: match[0], url: match[0] });
    last = match.index! + match[0].length;
  }
  if (last < text.length) {
    parts.push({ text: text.slice(last) });
  }
  return parts;
};

export const formatDuration = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
};
