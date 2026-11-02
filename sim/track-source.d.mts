export function trackSourceRanges(html: string): {
  arrayStart: number; arrayEnd: number;
  tracks: Array<{ id: number; start: number; end: number }>;
};
export function replaceTrackSource(html: string, track: Record<string, unknown> & { id: number }): string;
