/**
 * Shared client-side guard for short-form narration source videos.
 *
 * Both the fresh-upload path and the "Choose from storage" reuse path run a
 * video's measured metadata through THIS one function, so a reused file is held
 * to exactly the same rules (vertical 9:16, 15–90 s) a freshly-uploaded one is.
 *
 * Returns a human-readable error string, or null when the video is acceptable.
 */
export function validateNarrationMeta(duration: number, aspectRatio: number): string | null {
  if (aspectRatio > 0.7) return 'Video must be vertical (9:16 aspect ratio)';
  if (duration < 15 || duration > 90) return 'Video must be 15–90 seconds long';
  return null;
}
