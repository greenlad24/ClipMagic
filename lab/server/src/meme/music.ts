/**
 * Random background-music picker for the Meme/Sticker editor.
 *
 * REUSES the SAME library + selection the short-form editor's "auto" mode uses:
 * the `MusicTracks` collection (server/src/zite/store.ts), filtered to the user's
 * ready tracks that have an `audioUrl`, then ONE chosen at random — identical to
 * the short-form TimelineEditorPage auto-pick (`ready[random]`). The chosen track
 * flows into the render via `manifest.music`, where build.ts already loops/trims
 * it to the video length and mixes it at the given (quiet) volume.
 */
import { MusicTracks } from "../zite/store.js";
import { MEME_MUSIC_VOLUME } from "./config.js";
import type { MusicTrack } from "../render/manifest.js";

/** The minimal track shape used here (matches MusicTracks docs). */
export interface PickableTrack {
  id: string;
  audioUrl?: string;
  trackName?: string;
  bpm?: number;
}

/**
 * Pure selection: from a list of tracks, keep the ones with a usable audioUrl and
 * return one at random as a MusicTrack at the meme volume, or null if none. The
 * `rng` is injectable so tests are deterministic; it mirrors the short-form
 * auto-pick (`ready[Math.floor(rng()*ready.length)]`).
 */
export function pickMusicTrack(
  tracks: PickableTrack[],
  rng: () => number = Math.random,
): MusicTrack | null {
  const ready = tracks.filter((t) => typeof t.audioUrl === "string" && t.audioUrl.length > 0);
  if (ready.length === 0) return null;
  const chosen = ready[Math.floor(rng() * ready.length)];
  return {
    audioUrl: chosen.audioUrl as string,
    volume: MEME_MUSIC_VOLUME,
    trackName: chosen.trackName,
    bpm: chosen.bpm,
  };
}

/**
 * Load the user's music library and pick one track at random for the meme render.
 * Best-effort: returns null (no music) on any error or empty library so the
 * render is never blocked — captions + stickers still apply.
 */
export async function pickRandomMusicTrack(userId: string): Promise<MusicTrack | null> {
  try {
    const { records } = await MusicTracks.findAll({ filters: { user: userId }, limit: 200 });
    const tracks: PickableTrack[] = records.map((t) => ({
      id: t.id as string,
      audioUrl: t.audioUrl as string | undefined,
      trackName: t.trackName as string | undefined,
      bpm: t.bpm as number | undefined,
    }));
    return pickMusicTrack(tracks);
  } catch (e) {
    console.warn(
      `[meme] music pick skipped — no background bed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
