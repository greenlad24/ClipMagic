import { useEffect, useRef, useState } from 'react';
import { Volume2, Upload, Loader2, RotateCcw, Play, Square, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { getStickerSound, setStickerSound, setStickerSoundSpeed, resetStickerSound } from 'zite-endpoints-sdk';
import { uploadBlobToZite } from '@/utils/videoUtils';

/**
 * The sticker SOUND control.
 *
 * Every sticker slaps on with a short sound under it. This card shows which
 * sound is in force, plays it, and lets you replace it with your own file.
 *
 * The upload rides the ordinary upload route and is then CONFORMED server-side
 * (48kHz stereo, trimmed, peak-normalised) before it is stored — see
 * server/src/meme/sfx.ts. That is why the card can promise the sound will sit at
 * the same level as the built-in one: the server guarantees it rather than
 * trusting whatever was in the file.
 */

interface SoundState {
  mode: 'default' | 'custom' | 'env';
  name: string;
  previewUrl: string | null;
  volume: number;
  enabled: boolean;
  custom: { name: string; seconds: number; trimmed: boolean; speed: number } | null;
  maxSeconds: number;
  speed: number;
  minSpeed: number;
  maxSpeed: number;
}

/**
 * The rates offered. Deliberately a short list rather than a slider: the useful
 * range for a sticker hit is narrow, and a preset you can hit in one click beats
 * a continuous control nobody can land on twice.
 */
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export function StickerSoundCard() {
  const [sound, setSound] = useState<SoundState | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    getStickerSound({})
      .then((r: { sound: SoundState }) => setSound(r.sound))
      .catch(() => { /* the card just stays hidden if the server can't answer */ });
    return () => { audioRef.current?.pause(); };
  }, []);

  const preview = () => {
    if (!sound?.previewUrl) return;
    if (playing) { audioRef.current?.pause(); setPlaying(false); return; }
    // Cache-bust: a replaced sound keeps the same URL, and the browser would
    // otherwise play the previous one back.
    const a = new Audio(`${sound.previewUrl}?v=${Date.now()}`);
    audioRef.current = a;
    a.onended = () => setPlaying(false);
    a.onerror = () => { setPlaying(false); toast.error("Couldn't play that sound"); };
    a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadBlobToZite(file, file.name);
      // Carry the rate over: replacing a sound shouldn't silently reset a speed
      // that is still shown selected on the card.
      const { sound: next } = await setStickerSound({ url, name: file.name, speed: sound?.speed ?? 1 });
      setSound(next);
      toast.success(
        next.custom?.trimmed
          ? `Sticker sound set — trimmed to ${next.maxSeconds}s`
          : 'Sticker sound set',
      );
    } catch (e: any) {
      toast.error(e?.message?.slice(0, 160) ?? 'Could not use that file');
    } finally {
      setBusy(false);
    }
  };

  const changeSpeed = async (speed: number) => {
    if (busy || speed === sound?.speed) return;
    setBusy(true);
    try {
      const { sound: next } = await setStickerSoundSpeed({ speed });
      setSound(next);
      audioRef.current?.pause();
      setPlaying(false);
      toast.success(speed === 1 ? 'Back to the original speed' : `Sound sped to ${speed}×`);
    } catch (e: any) {
      toast.error(e?.message?.slice(0, 160) ?? 'Could not change the speed');
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    setBusy(true);
    try {
      const { sound: next } = await resetStickerSound({});
      setSound(next);
      toast.success('Back to the built-in slap');
    } catch (e: any) {
      toast.error(e?.message?.slice(0, 160) ?? 'Could not reset');
    } finally {
      setBusy(false);
    }
  };

  if (!sound) return null;

  const isCustom = sound.mode === 'custom';
  const pinned = sound.mode === 'env';

  return (
    <div className="rounded-xl border border-border p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          {sound.enabled
            ? <Volume2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            : <VolumeX className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />}
          <div className="min-w-0">
            <p className="text-sm font-medium">Sticker sound</p>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {!sound.enabled
                ? 'Switched off — stickers render silently'
                : <>
                    {isCustom ? 'Your sound' : pinned ? 'Pinned on the server' : 'Built-in slap'}
                    {' · '}
                    <span className="text-foreground">{sound.name}</span>
                  </>}
            </p>
          </div>
        </div>

        <div className="flex gap-1.5 shrink-0">
          {sound.previewUrl && sound.enabled && (
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={preview}>
              {playing ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {playing ? 'Stop' : 'Play'}
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5"
            disabled={busy || pinned} onClick={() => fileRef.current?.click()}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            {busy ? 'Working…' : isCustom ? 'Replace' : 'Upload'}
          </Button>
          {isCustom && (
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" disabled={busy} onClick={revert}>
              <RotateCcw className="w-3 h-3" /> Built-in
            </Button>
          )}
        </div>
      </div>

      {isCustom && sound.enabled && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground shrink-0">Speed</span>
          <div className="flex gap-1">
            {SPEEDS.map((s) => (
              <Button key={s} variant={s === sound.speed ? 'default' : 'outline'} size="sm"
                className="h-7 px-2 text-xs tabular-nums" disabled={busy}
                onClick={() => changeSpeed(s)}>
                {s}×
              </Button>
            ))}
          </div>
          {sound.custom && (
            <span className="text-xs text-muted-foreground">
              {sound.custom.seconds}s{sound.custom.trimmed && ' · trimmed'}
            </span>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {pinned
          ? 'A sound is pinned in the server configuration (MEME_SFX_PATH), so it cannot be changed from here.'
          : <>Any audio file (or a video — its sound is taken). It is trimmed to {sound.maxSeconds}s and
             levelled to match, then mixed under the narration at {Math.round(sound.volume * 100)}% as each
             sticker lands.{isCustom && ' Speed changes the tempo, not the pitch, and always applies to the'
               + ' file you uploaded — so the rates never stack.'}</>}
      </p>

      <input ref={fileRef} type="file" accept="audio/*,video/*" className="hidden"
        onChange={(e) => { onPick(e.target.files?.[0]); e.currentTarget.value = ''; }} />
    </div>
  );
}
