import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  avatarStatus,
  avatarEstimate,
  avatarPreviewPortrait,
  avatarEditPortrait,
  avatarPreviewVoice,
  avatarDesignVoice,
  avatarCloneVoice,
  avatarListPortraits,
  avatarListVoiceSamples,
  avatarDeleteVoiceSample,
  avatarDeletePortrait,
  avatarCreatePersona,
  avatarCharacterSheet,
  avatarPlaceInRoom,
  avatarDeletePersona,
  avatarStartVideo,
  avatarVideoStatus,
  avatarListVideos,
  avatarCancelVideo,
  avatarRetryVideo,
  avatarDeleteVideo,
  type AvatarPersona,
  type AvatarVideo,
  type AvatarCostEstimate,
  type AvatarProviderId,
  type AvatarResolution,
  type AvatarVoiceOption,
  type AvatarPortraitRoll,
  type AvatarVoiceSample,
  type AvatarVoiceSettings,
  type AvatarMedium,
  type AvatarLookPreset,
  type TtsProviderId,
} from 'zite-endpoints-sdk';
import { toast } from 'sonner';
import Layout from '@/components/Layout';
import { RoomStudio } from '@/components/avatar/RoomStudio';
import PersonaBuilder from '@/components/avatar/PersonaBuilder';
import VoiceStudio from '@/components/avatar/VoiceStudio';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  UserRound,
  Video,
  Wand2,
  KeyRound,
  AlertTriangle,
  CheckCircle2,
  Settings,
  RefreshCw,
  Trash2,
  Download,
  X,
  Clock,
  DollarSign,
  Zap,
  Film,
} from 'lucide-react';

/**
 * Avatar Narrator — synthetic-presenter narration videos (LAB tool).
 *
 * The pipeline is deliberately NOT a text-to-video model. Seedance/Veo/Kling
 * generate a scene with their own audio: ~$0.15–0.50 per second, 30-second
 * ceiling, no control over the exact words and no voice continuity between
 * clips. This tool instead locks ONE synthetic portrait as a persona, speaks the
 * script through TTS, and drives the face with an audio-driven lipsync model
 * (Seedance 2.5 on Segmind). That runs at ~$4.90 per 45-second Short at 480p,
 * says exactly what you wrote, and looks like the same person every time.
 *
 * Two things decide whether the output reads as real, and both live here:
 *   • The PORTRAIT — generated against a fixed spec (mouth closed, even frontal
 *     light, chest-up framing) because the video model animates that still, it
 *     does not improve it. Roll until you like it, then lock it in.
 *   • CONTINUOUS vs FAST — one job for the whole script has no seam; parallel
 *     chunks are ~4x faster in wall-clock but you can see the joins. Continuous
 *     is the default.
 */

const RESOLUTIONS: { value: AvatarResolution; label: string; hint: string }[] = [
  { value: '480p', label: '480p', hint: '$0.1065/sec — the default; ~$4.79 per 45s Short' },
  { value: '720p', label: '720p', hint: '$0.2389/sec — 2.2x the price, for a video that earns it' },
];

/** Fast mode chunk length. Kept coarse — the exact value barely matters. */
const FAST_SEGMENT_SECONDS = 30;

function usd(n: number): string {
  if (!n) return '$0.00';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function duration(seconds: number): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const ACTIVE_STATES = new Set(['queued', 'voicing', 'rendering', 'stitching']);

/**
 * How long each blocking step actually takes, measured rather than guessed.
 * GPT Image 2 came back in 88s on the first real portrait; Segmind advertise
 * ~99.6s for the model. Voice is a much shorter request.
 */
const EXPECTED_SECONDS = { portrait: 90, edit: 75, voice: 12, clone: 20, design: 25 };

/**
 * A progress bar for a call that cannot report progress.
 *
 * The image and voice endpoints are single blocking HTTP requests: there is no
 * server-side percentage to poll, and a bare spinner for ninety seconds reads
 * as a hang rather than as work. So this estimates from elapsed time against
 * how long the step really takes — and deliberately stops short of 100% until
 * the response lands. A bar pinned at 100% while still waiting would be a lie;
 * one easing towards 96% is an honest estimate, and the elapsed seconds beside
 * it are the ground truth if the estimate is wrong.
 */
function ElapsedProgress({
  startedAt,
  expectedSeconds,
  label,
}: {
  startedAt: number;
  expectedSeconds: number;
  label: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [startedAt]);

  const elapsed = Math.max(0, (now - startedAt) / 1000);
  const pct = Math.min(96, Math.round((elapsed / expectedSeconds) * 100));
  const over = elapsed > expectedSeconds * 1.2;

  return (
    <div className="space-y-1.5 pt-1">
      <Progress value={pct} className="h-2" />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {pct}% · {Math.round(elapsed)}s
          {over ? ' — longer than usual, still going' : ` of ~${expectedSeconds}s`}
        </span>
      </div>
    </div>
  );
}

export default function AvatarNarratorPage() {
  // ── Config + library ───────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<{ id: AvatarProviderId; label: string; configured: boolean }[]>([]);
  const [ttsReady, setTtsReady] = useState<Record<string, boolean>>({});
  const [voices, setVoices] = useState<AvatarVoiceOption[]>([]);
  const [publicUrlOk, setPublicUrlOk] = useState(true);
  const [defaultScene, setDefaultScene] = useState('');
  const [personas, setPersonas] = useState<AvatarPersona[]>([]);
  const [totalSpend, setTotalSpend] = useState(0);

  // ── Persona builder ────────────────────────────────────────────────────────
  const [description, setDescription] = useState('');
  const [aspect, setAspect] = useState('9:16');
  const [mediumId, setMediumId] = useState('');
  const [mediums, setMediums] = useState<AvatarMedium[]>([]);
  const [framings, setFramings] = useState<AvatarMedium[]>([]);
  const [framingId, setFramingId] = useState('medium');
  // The fixed set. '' = no plate, room described in words instead.
  const [rooms, setRooms] = useState<Array<{ id: string; label: string; hint: string; ready: boolean }>>([]);
  const [roomId, setRoomId] = useState('');
  // The "move an existing persona somewhere else" flow, which is separate from
  // building one: it starts from a face that already works.
  const [sheeting, setSheeting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<{ file: string; url: string; usedSheet: boolean; roomId: string } | null>(null);
  const [presets, setPresets] = useState<AvatarLookPreset[]>([]);
  const [preview, setPreview] = useState<{ file: string; url: string } | null>(null);
  const [rolling, setRolling] = useState(false);
  const [rollStartedAt, setRollStartedAt] = useState(0);
  // Rolls survive a refresh: they are files on disk, and each one cost money.
  const [rolls, setRolls] = useState<AvatarPortraitRoll[]>([]);
  const [editInstruction, setEditInstruction] = useState('');
  const [editing, setEditing] = useState(false);
  const [editStartedAt, setEditStartedAt] = useState(0);
  // Toasts fade; a step that failed 90 seconds ago still has to be able to say
  // why, so the panel does not just silently revert.
  const [portraitError, setPortraitError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // The voice half of a persona: roll a sample, then clone it. The SAMPLE is
  // archived on the persona, because the cloned model belongs to the vendor.
  const [voiceSample, setVoiceSample] = useState<{ file: string; url: string; seconds: number } | null>(null);
  const [voicing, setVoicing] = useState(false);
  const [voicingStartedAt, setVoicingStartedAt] = useState(0);
  const [cloning, setCloning] = useState(false);
  const [cloningStartedAt, setCloningStartedAt] = useState(0);
  const [voiceDescription, setVoiceDescription] = useState('');
  const [designing, setDesigning] = useState(false);
  const [designStartedAt, setDesignStartedAt] = useState(0);
  // Set when the design endpoint already persisted a voice, which makes the
  // separate clone step unnecessary.
  const [designedVoiceId, setDesignedVoiceId] = useState<string | null>(null);
  const [voiceSamples, setVoiceSamples] = useState<AvatarVoiceSample[]>([]);
  const [auditionText, setAuditionText] = useState('');
  const [auditionOpen, setAuditionOpen] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState<AvatarVoiceSettings>({
    model: 'eleven_v3',
    speed: 1.05,
    stability: 0.35,
    similarityBoost: 0.75,
    style: 0.35,
    speakerBoost: true,
  });
  const [voiceModels, setVoiceModels] = useState<{ id: string; label: string; hint: string }[]>([]);
  const [personaName, setPersonaName] = useState('');
  const [personaVoice, setPersonaVoice] = useState('Rachel');
  const [personaTts, setPersonaTts] = useState<TtsProviderId>('segmind');

  // ── Render form ────────────────────────────────────────────────────────────
  const [personaId, setPersonaId] = useState('');
  const [title, setTitle] = useState('');
  const [script, setScript] = useState('');
  const [provider, setProvider] = useState<AvatarProviderId>('kie');
  const [resolution, setResolution] = useState<AvatarResolution>('720p');
  const [fastMode, setFastMode] = useState(false);
  const [estimate, setEstimate] = useState<AvatarCostEstimate | null>(null);
  const [starting, setStarting] = useState(false);

  // ── Runs ───────────────────────────────────────────────────────────────────
  const [videos, setVideos] = useState<AvatarVideo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<AvatarVideo | null>(null);
  const pollRef = useRef<number | null>(null);

  const refreshVideos = useCallback(async () => {
    try {
      const res = await avatarListVideos({ limit: 60 });
      setVideos(res.videos);
      setTotalSpend(res.totalSpendUsd);
      // Re-attach to a render still in flight (a reload, or a run resumed after
      // a server restart) so the operator does not lose sight of it.
      const running = res.videos.find((v) => ACTIVE_STATES.has(v.status));
      if (running) setActiveId((cur) => cur ?? running.id);
    } catch {
      /* the status card already reports connectivity problems */
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await avatarStatus({});
      setProviders(res.providers);
      setTtsReady(res.ttsConfigured);
      setVoices(res.geminiVoices);
      setPublicUrlOk(res.publicBaseUrlConfigured);
      setDefaultScene(res.defaultScenePrompt);
      setAuditionText((cur) => cur || res.auditionText || '');
      if (res.voiceSettings) setVoiceSettings(res.voiceSettings);
      setVoiceModels(res.voiceModels ?? []);
      setMediums(res.mediums ?? []);
      setFramings(res.framings ?? []);
      setRooms(res.rooms ?? []);
      setPresets(res.presets ?? []);
      setMediumId((cur) => cur || res.mediums?.[0]?.id || '');
      setPersonas(res.personas);
      setTotalSpend(res.totalSpendUsd);
      setPersonaId((cur) => cur || res.personas[0]?.id || '');
      const firstReady = res.providers.find((p) => p.configured);
      if (firstReady) setProvider(firstReady.id);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not load the Avatar Narrator status.');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshVoiceSamples = useCallback(async () => {
    try {
      const res = await avatarListVoiceSamples({ limit: 40 });
      setVoiceSamples(res.samples ?? []);
    } catch {
      /* a convenience list — never block the voice controls on it */
    }
  }, []);

  const refreshRolls = useCallback(async () => {
    try {
      const res = await avatarListPortraits({ limit: 40 });
      setRolls(res.portraits ?? []);
    } catch {
      /* the gallery is a convenience — a failed listing must not block a roll */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void refreshVideos();
    void refreshRolls();
    void refreshVoiceSamples();
  }, [loadStatus, refreshVideos, refreshRolls, refreshVoiceSamples]);

  // Poll the active render. A render runs for tens of minutes, so 4s is plenty
  // frequent and keeps the request count sane over an hour-long job.
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;

    const tick = async () => {
      try {
        const { video } = await avatarVideoStatus({ videoId: activeId });
        if (stopped) return;
        setActive(video);
        if (!ACTIVE_STATES.has(video.status)) {
          setActiveId(null);
          void refreshVideos();
          if (video.status === 'done') toast.success('Narration video is ready.');
          if (video.status === 'failed') toast.error(video.error ?? 'The render failed.');
        }
      } catch {
        /* transient — keep polling */
      }
    };

    void tick();
    pollRef.current = window.setInterval(tick, 4000);
    return () => {
      stopped = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [activeId, refreshVideos]);

  // Live cost estimate. Debounced because it re-runs on every keystroke of a
  // script that can be thousands of characters long.
  useEffect(() => {
    if (!script.trim()) {
      setEstimate(null);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const persona = personas.find((p) => p.id === personaId);
        setEstimate(
          await avatarEstimate({
            script,
            provider,
            resolution,
            tts: persona?.ttsProvider ?? 'gemini',
            segmentSeconds: fastMode ? FAST_SEGMENT_SECONDS : 0,
          }),
        );
      } catch {
        setEstimate(null);
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [script, provider, resolution, fastMode, personaId, personas]);

  const providerReady = useMemo(
    () => providers.find((p) => p.id === provider)?.configured ?? false,
    [providers, provider],
  );
  const anyProviderReady = providers.some((p) => p.configured);
  // One Segmind key powers the portrait, the voice and the video, so voice
  // readiness is the same key as engine readiness — not Gemini's any more.
  const voiceReady = ttsReady.segmind ?? false;
  const ready = anyProviderReady && voiceReady && publicUrlOk;
  const blockedReason = !anyProviderReady
    ? 'No Segmind API key — add SEGMIND_API_KEY in Settings.'
    : !publicUrlOk
      ? 'PUBLIC_BASE_URL is not set, so the engine cannot fetch your portrait or narration.'
      : undefined;

  // ── Persona actions ────────────────────────────────────────────────────────

  const discardRoll = async (file: string) => {
    try {
      await avatarDeletePortrait({ file });
      setRolls((cur) => cur.filter((r) => r.file !== file));
      if (preview?.file === file) setPreview(null);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not delete that roll.');
    }
  };

  const rollPortrait = async () => {
    if (!description.trim()) {
      toast.error('Describe the presenter first.');
      return;
    }
    setPortraitError(null);
    setRolling(true);
    setRollStartedAt(Date.now());
    try {
      const res = await avatarPreviewPortrait({ description, aspect, mediumId, framingId, roomId });
      setPreview({ file: res.file, url: res.url });
      void refreshRolls();
    } catch (e: any) {
      const m = e?.message ?? 'Portrait generation failed.';
      setPortraitError(m);
      toast.error(m);
    } finally {
      setRolling(false);
    }
  };

  /**
   * Speak the audition paragraph in a given voice. A voice you will listen to
   * for forty minutes cannot be judged on one short sentence — this is the
   * script that forces the pitch changes, the aside and the long clause to
   * actually happen.
   */
  const rollVoice = async (voiceOverride?: string) => {
    setVoiceError(null);
    setVoicing(true);
    setVoicingStartedAt(Date.now());
    try {
      const res = await avatarPreviewVoice({
        ttsProvider: personaTts,
        voice: voiceOverride || personaVoice,
        text: auditionText || undefined,
        settings: voiceSettings,
      });
      setVoiceSample({ file: res.file, url: res.url, seconds: res.seconds });
      setDesignedVoiceId(null);
      void refreshVoiceSamples();
    } catch (e: any) {
      const m = e?.message ?? 'Voice preview failed.';
      setVoiceError(m);
      toast.error(m);
    } finally {
      setVoicing(false);
    }
  };

  const designNewVoice = async () => {
    if (voiceDescription.trim().length < 20) {
      toast.error('Describe the voice in more detail — age, gender, accent, pace, texture.');
      return;
    }
    setVoiceError(null);
    setDesigning(true);
    setDesignStartedAt(Date.now());
    try {
      const res = await avatarDesignVoice({ description: voiceDescription });
      setVoiceSample({ file: res.file, url: res.url, seconds: res.seconds });
      // Some backends hand back a usable id straight away; when they do, the
      // persona can speak with it without a separate clone step.
      if (res.voiceId) setPersonaVoice(res.voiceId);
      setDesignedVoiceId(res.voiceId);
      toast.success(
        res.voiceId
          ? 'Voice designed and saved — listen, then lock the persona in.'
          : 'Voice designed — listen, then clone it to keep it.',
      );
      void refreshVoiceSamples();
    } catch (e: any) {
      const m = e?.message ?? 'Voice design failed.';
      setVoiceError(m);
      toast.error(m);
    } finally {
      setDesigning(false);
    }
  };

  const cloneSampleVoice = async () => {
    if (!voiceSample) return;
    if (!personaName.trim()) {
      toast.error('Name the persona first — the cloned voice is stored under that name.');
      return;
    }
    setVoiceError(null);
    setCloning(true);
    setCloningStartedAt(Date.now());
    try {
      const res = await avatarCloneVoice({ name: personaName.trim(), file: voiceSample.file });
      // From here the persona speaks with the clone, and the sample it was made
      // from travels with it.
      setPersonaVoice(res.voiceId);
      setVoiceSample((cur) => (cur ? { ...cur, file: res.sampleFile, url: res.sampleUrl } : cur));
      toast.success('Voice cloned — the persona now uses it.');
    } catch (e: any) {
      const m = e?.message ?? 'Voice cloning failed.';
      setVoiceError(m);
      toast.error(m);
    } finally {
      setCloning(false);
    }
  };

  /**
   * Refine the selected portrait rather than re-rolling. The instruction is
   * plain language; the server writes the prompt, most of which is spent
   * forbidding a different face from coming back.
   */
  const improvePortrait = async () => {
    if (!preview) return;
    if (!editInstruction.trim()) {
      toast.error('Say what you want changed.');
      return;
    }
    setPortraitError(null);
    setEditing(true);
    setEditStartedAt(Date.now());
    try {
      const res = await avatarEditPortrait({ file: preview.file, instruction: editInstruction, aspect, mediumId });
      setPreview({ file: res.file, url: res.url });
      setEditInstruction('');
      void refreshRolls();
      toast.success('Edited — the original is still in your rolls.');
    } catch (e: any) {
      const m = e?.message ?? 'Edit failed.';
      setPortraitError(m);
      toast.error(m);
    } finally {
      setEditing(false);
    }
  };

  const makeSheet = async (id: string) => {
    setSheeting(true);
    try {
      const { persona } = await avatarCharacterSheet({ personaId: id });
      setPersonas((cur) => cur.map((p) => (p.id === persona.id ? persona : p)));
      toast.success('Character sheet built — twenty angles on file.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not build the character sheet.');
    } finally {
      setSheeting(false);
    }
  };

  const placePersona = async (id: string, room: string) => {
    setPlacing(true);
    try {
      const res = await avatarPlaceInRoom({ personaId: id, roomId: room });
      setPlaced({ file: res.file, url: res.url, usedSheet: res.usedSheet, roomId: res.roomId });
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not place them in that room.');
    } finally {
      setPlacing(false);
    }
  };

  /**
   * Keep a placement as its own persona.
   *
   * Everything except the portrait and the room is inherited from the persona
   * it came from — same voice, same scene direction — because this is the same
   * presenter in a different place, not a new one.
   */
  const keepPlacement = async () => {
    if (!placed) return;
    const from = personas.find((p) => p.id === personaId);
    if (!from) return;
    const room = rooms.find((r) => r.id === placed.roomId);
    try {
      const { persona } = await avatarCreatePersona({
        name: `${from.name} — ${room?.label ?? 'room'}`,
        file: placed.file,
        lookPrompt: from.lookPrompt,
        roomId: placed.roomId,
        scenePrompt: from.scenePrompt,
        ttsProvider: from.ttsProvider,
        ttsVoice: from.ttsVoice,
        voiceSampleFile: from.voiceSampleFile || undefined,
      });
      setPersonas((cur) => [persona, ...cur]);
      setPersonaId(persona.id);
      setPlaced(null);
      toast.success(`Saved as "${persona.name}".`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save that placement.');
    }
  };

  const savePersona = async () => {
    if (!preview) return;
    if (!personaName.trim()) {
      toast.error('Give the persona a name.');
      return;
    }
    try {
      const { persona } = await avatarCreatePersona({
        name: personaName.trim(),
        file: preview.file,
        lookPrompt: description,
        // Stored on the persona so every video it renders returns to this room.
        roomId,
        voiceSampleFile: voiceSample?.file,
        scenePrompt: defaultScene,
        ttsProvider: personaTts,
        ttsVoice: personaVoice,
      });
      setPersonas((cur) => [persona, ...cur]);
      setPersonaId(persona.id);
      setPreview(null);
      setPersonaName('');
      setDescription('');
      toast.success(`Persona "${persona.name}" locked in.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save the persona.');
    }
  };

  const removePersona = async (p: AvatarPersona) => {
    if (!window.confirm(`Delete "${p.name}" and every video made with it? This cannot be undone.`)) return;
    try {
      await avatarDeletePersona({ id: p.id });
      setPersonas((cur) => cur.filter((x) => x.id !== p.id));
      if (personaId === p.id) setPersonaId('');
      void refreshVideos();
      toast.success('Persona deleted.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Delete failed.');
    }
  };

  // ── Render actions ─────────────────────────────────────────────────────────

  /**
   * Retry resumes: the server reuses narration already bought and keeps the
   * provider jobs that were accepted, so a run that died on an out-of-credit
   * error finishes without paying for the same seconds twice.
   */
  const retry = async (v: AvatarVideo) => {
    try {
      await avatarRetryVideo({ videoId: v.id });
      setActiveId(v.id);
      void refreshVideos();
      toast.success('Resuming — narration already paid for is reused.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not retry that render.');
    }
  };

  const start = async () => {
    if (!personaId) {
      toast.error('Pick a persona.');
      return;
    }
    if (!script.trim()) {
      toast.error('Write a script.');
      return;
    }
    setStarting(true);
    try {
      const { videoId } = await avatarStartVideo({
        personaId,
        title: title.trim(),
        script,
        provider,
        resolution,
        segmentSeconds: fastMode ? FAST_SEGMENT_SECONDS : 0,
      });
      setActiveId(videoId);
      toast.success('Render started — this takes a while, you can leave the page.');
      void refreshVideos();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not start the render.');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await avatarCancelVideo({ videoId: id });
      setActiveId(null);
      void refreshVideos();
      toast.success('Canceled.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Cancel failed.');
    }
  };

  const removeVideo = async (v: AvatarVideo) => {
    if (!window.confirm('Delete this render and its files?')) return;
    try {
      await avatarDeleteVideo({ videoId: v.id });
      void refreshVideos();
    } catch (e: any) {
      toast.error(e?.message ?? 'Delete failed.');
    }
  };

  const selectedPersona = personas.find((p) => p.id === personaId) ?? null;

  return (
    <Layout breadcrumb="Avatar Narrator">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <header className="mb-6">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-[hsl(var(--chart-4))]/10 p-2 text-[hsl(var(--chart-4))]">
              <UserRound className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Avatar Narrator</h1>
              <p className="text-sm text-muted-foreground">
                A synthetic presenter reads your script. One locked face, one cloned voice, every video — generated
                by Seedance 2.5 at about <span className="font-medium text-foreground">$4.90 per 45-second Short</span>{' '}
                at 480p.
              </p>
            </div>
          </div>
        </header>

        {/* ── Readiness ──────────────────────────────────────────────────── */}
        {!loading && !ready && (
          <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-sm space-y-2">
                <p className="font-medium text-foreground">Not ready yet</p>
                <ul className="space-y-1 text-muted-foreground">
                  {!anyProviderReady && (
                    <li>
                      <KeyRound className="w-3.5 h-3.5 inline mr-1.5" />
                      No engine configured. Add <code className="text-xs">SEGMIND_API_KEY</code> to{' '}
                      <code className="text-xs">.env</code> and restart the server — one key covers
                      the portrait, the voice and the video.
                    </li>
                  )}
                  {anyProviderReady && !voiceReady && (
                    <li>
                      <KeyRound className="w-3.5 h-3.5 inline mr-1.5" />
                      The engine is configured but the narration voice is not — check the Segmind key covers
                      text-to-speech as well as video.
                    </li>
                  )}
                  {!publicUrlOk && (
                    <li>
                      <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5" />
                      <code className="text-xs">PUBLIC_BASE_URL</code> is not set. The avatar API fetches the portrait
                      and narration by URL, so this server has to know its own public origin.
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
          {/* ── Personas ─────────────────────────────────────────────────── */}
          <aside className="space-y-4">
            <div className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold flex items-center gap-1.5">
                  <UserRound className="w-4 h-4" /> Personas
                </h2>
                <Badge variant="secondary" className="text-xs">
                  {personas.length}
                </Badge>
              </div>

              {personas.length === 0 && (
                <p className="text-xs text-muted-foreground mb-3">
                  No personas yet. Build one below — it gets reused by every video, so it is worth re-rolling until the
                  face is right.
                </p>
              )}

              <div className="space-y-2">
                {personas.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPersonaId(p.id)}
                    className={cn(
                      'w-full flex items-center gap-3 rounded-md border p-2 text-left transition-colors',
                      personaId === p.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/40',
                    )}
                  >
                    <img
                      src={p.portraitUrl}
                      alt={p.name}
                      className="w-12 h-12 rounded object-cover bg-muted shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">{p.name}</span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {p.ttsProvider === 'gemini' ? p.ttsVoice || 'Gemini' : 'ElevenLabs'}
                      </span>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void removePersona(p);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation();
                          void removePersona(p);
                        }
                      }}
                      className="text-muted-foreground hover:text-destructive p-1 shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* The other direction: not "build a persona with a room" but
                "take this persona and photograph it somewhere else". */}
            <RoomStudio
              personas={personas}
              rooms={rooms}
              personaId={personaId}
              onPersonaChange={setPersonaId}
              onMakeSheet={makeSheet}
              onPlace={placePersona}
              placed={placed}
              onKeep={keepPlacement}
              onDiscard={() => setPlaced(null)}
              sheeting={sheeting}
              placing={placing}
              disabled={!anyProviderReady}
            />

            {/* ── Build a persona ──────────────────────────────────────────
                Two components own the two halves of this journey. Everything
                below is state and side effects; the layout, the step model and
                the comparison affordances live in PersonaBuilder/VoiceStudio,
                which is why this file no longer carries 400 lines of JSX. */}
            <PersonaBuilder
              presets={presets}
              mediums={mediums}
              rooms={rooms}
              roomId={roomId}
              onRoomChange={setRoomId}
              rolls={rolls}
              description={description}
              onDescriptionChange={setDescription}
              mediumId={mediumId}
              onMediumChange={setMediumId}
              aspect={aspect}
              onAspectChange={setAspect}
              editInstruction={editInstruction}
              onEditInstructionChange={setEditInstruction}
              preview={preview}
              onSelectRoll={(r) => setPreview({ file: r.file, url: r.url })}
              onDeleteRoll={discardRoll}
              onApplyPreset={(pr) => {
                setDescription(pr.description);
                setMediumId(pr.mediumId);
                setPersonaVoice(pr.voice);
              }}
              onGenerate={rollPortrait}
              onImprove={improvePortrait}
              onClearPreview={() => setPreview(null)}
              generating={rolling}
              generatingStartedAt={rollStartedAt}
              editing={editing}
              editingStartedAt={editStartedAt}
              disabled={!anyProviderReady || !publicUrlOk}
              disabledReason={blockedReason}
              lastError={portraitError}
            />

            {preview && (
              <div className="rounded-lg border border-border p-4 space-y-3">
                <VoiceStudio
                  samples={voiceSamples}
                  voiceDescription={voiceDescription}
                  onVoiceDescriptionChange={setVoiceDescription}
                  auditionText={auditionText}
                  onAuditionTextChange={setAuditionText}
                  voice={personaVoice}
                  onVoiceChange={setPersonaVoice}
                  currentSample={voiceSample}
                  designedVoiceId={designedVoiceId}
                  onDesign={designNewVoice}
                  onAudition={(id) => rollVoice(id)}
                  onUseSample={(sm) => {
                    setVoiceSample({ file: sm.file, url: sm.url, seconds: sm.seconds });
                    setDesignedVoiceId(sm.voiceId);
                    if (sm.voiceId) setPersonaVoice(sm.voiceId);
                  }}
                  onDeleteSample={async (file) => {
                    try {
                      await avatarDeleteVoiceSample({ file });
                      setVoiceSamples((cur) => cur.filter((x) => x.file !== file));
                    } catch (e: any) {
                      toast.error(e?.message ?? 'Could not delete that sample.');
                    }
                  }}
                  designing={designing}
                  designStartedAt={designStartedAt}
                  auditioning={voicing}
                  auditionStartedAt={voicingStartedAt}
                  disabled={!voiceReady}
                  settings={voiceSettings}
                  onSettingsChange={setVoiceSettings}
                  models={voiceModels}
                  disabledReason={blockedReason}
                  lastError={voiceError}
                />

                {/* Acceptance lives here, not in either component: a persona is
                    a face AND a voice, so neither half can commit it alone. */}
                <div className="flex gap-2 border-t border-border pt-3">
                  <Input
                    value={personaName}
                    onChange={(e) => setPersonaName(e.target.value)}
                    placeholder="Name this presenter"
                    className="h-9 text-sm flex-1"
                  />
                  <Button size="sm" onClick={savePersona} className="h-9">
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Lock it in
                  </Button>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <DollarSign className="w-4 h-4" /> Total spend
                </span>
                <span className="font-semibold tabular-nums">{usd(totalSpend)}</span>
              </div>
            </div>
          </aside>

          {/* ── Render ───────────────────────────────────────────────────── */}
          <main className="space-y-6">
            <div className="rounded-lg border border-border p-4 space-y-4">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <Video className="w-4 h-4" /> New narration
              </h2>

              <div className="flex flex-col sm:flex-row gap-2">
                <Select value={personaId} onValueChange={setPersonaId}>
                  <SelectTrigger className="h-9 text-sm sm:w-56">
                    <SelectValue placeholder="Pick a persona" />
                  </SelectTrigger>
                  <SelectContent>
                    {personas.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Video title"
                  className="h-9 text-sm flex-1"
                />
              </div>

              <Textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder="Paste the narration script. It is spoken verbatim — write it the way you want it read."
                rows={10}
                className="text-sm font-mono leading-relaxed"
              />

              <div className="flex flex-wrap gap-2">
                <Select value={provider} onValueChange={(v) => setProvider(v as AvatarProviderId)}>
                  <SelectTrigger className="h-9 text-xs w-auto min-w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id} disabled={!p.configured}>
                        {p.label} {p.configured ? '' : '(no key)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={resolution} onValueChange={(v) => setResolution(v as AvatarResolution)}>
                  <SelectTrigger className="h-9 text-xs w-auto min-w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label} — {r.hint}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  size="sm"
                  variant={fastMode ? 'default' : 'outline'}
                  onClick={() => setFastMode((f) => !f)}
                  className="h-9 text-xs"
                >
                  <Zap className="w-3.5 h-3.5 mr-1.5" />
                  {fastMode ? 'Fast mode on' : 'Fast mode off'}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                {fastMode ? (
                  <>
                    <span className="text-foreground font-medium">Fast mode:</span> the script renders as parallel{' '}
                    {FAST_SEGMENT_SECONDS}-second chunks — roughly 4x quicker, slightly more expensive (every job bills
                    a 5-second minimum), and the joins between chunks are visible. Good for drafts.
                  </>
                ) : (
                  <>
                    <span className="text-foreground font-medium">Continuous:</span> one unbroken render, no seams. The
                    provider needs about 20 seconds of processing per second of video, so a 3-minute script takes
                    roughly an hour. You can close the page.
                  </>
                )}
              </p>

              {estimate && (
                <div className="rounded-md bg-muted/40 border border-border p-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Length</span>
                    <span className="font-medium tabular-nums">~{duration(estimate.seconds)}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Film className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Jobs</span>
                    <span className="font-medium tabular-nums">{estimate.segments}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">Video</span>
                    <span className="font-medium tabular-nums">{usd(estimate.videoUsd)}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">Voice</span>
                    <span className="font-medium tabular-nums">{usd(estimate.ttsUsd)}</span>
                  </span>
                  <span className="flex items-center gap-1.5 ml-auto">
                    <DollarSign className="w-3.5 h-3.5 text-[hsl(var(--chart-4))]" />
                    <span className="font-semibold tabular-nums">{usd(estimate.totalUsd)}</span>
                    <span className="text-muted-foreground">({usd(estimate.perMinuteUsd)}/min)</span>
                  </span>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button onClick={start} disabled={starting || !ready || !providerReady || !!activeId}>
                  <Video className="w-4 h-4 mr-2" />
                  {starting ? 'Starting…' : 'Render narration'}
                </Button>
                {!!activeId && (
                  <span className="text-xs text-muted-foreground">A render is already running.</span>
                )}
                {selectedPersona && (
                  <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1.5">
                    <Settings className="w-3.5 h-3.5" />
                    {selectedPersona.name} · {selectedPersona.ttsVoice || selectedPersona.ttsProvider}
                  </span>
                )}
              </div>
            </div>

            {/* ── Active render ──────────────────────────────────────────── */}
            {active && ACTIVE_STATES.has(active.status) && (
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{active.title || 'Untitled narration'}</span>
                  <Button size="sm" variant="ghost" onClick={() => cancel(active.id)}>
                    <X className="w-3.5 h-3.5 mr-1.5" /> Cancel
                  </Button>
                </div>
                <Progress value={Math.round(active.progress * 100)} className="h-2" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{active.phase}</span>
                  <span className="tabular-nums">{Math.round(active.progress * 100)}%</span>
                </div>
                {active.segments.length > 1 && (
                  <div className="flex flex-wrap gap-1">
                    {active.segments.map((s) => (
                      <span
                        key={s.id}
                        title={`Segment ${s.idx + 1}: ${s.status}`}
                        className={cn(
                          'h-1.5 w-6 rounded-full',
                          s.status === 'done'
                            ? 'bg-[hsl(var(--chart-2))]'
                            : s.status === 'failed'
                              ? 'bg-destructive'
                              : s.status === 'submitted'
                                ? 'bg-primary/60'
                                : 'bg-muted',
                        )}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── History ────────────────────────────────────────────────── */}
            <div className="space-y-3">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <Film className="w-4 h-4" /> Renders
              </h2>

              {videos.length === 0 && (
                <p className="text-sm text-muted-foreground">Nothing rendered yet.</p>
              )}

              {videos.map((v) => (
                <div key={v.id} className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{v.title || 'Untitled narration'}</p>
                      <p className="text-xs text-muted-foreground">
                        {v.personaName} · {v.resolution} · {duration(v.audioSeconds)} · {usd(v.costUsd)} ·{' '}
                        {relTime(v.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        variant={v.status === 'done' ? 'secondary' : v.status === 'failed' ? 'destructive' : 'outline'}
                        className="text-xs"
                      >
                        {v.status}
                      </Badge>
                      {(v.status === 'failed' || v.status === 'canceled') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          title="Resume this render — narration already paid for is reused"
                          onClick={() => retry(v)}
                        >
                          <RefreshCw className="mr-1 h-3.5 w-3.5" />
                          Retry
                        </Button>
                      )}
                      {ACTIVE_STATES.has(v.status) ? (
                        <Button size="sm" variant="ghost" onClick={() => cancel(v.id)}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => removeVideo(v)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {v.error && <p className="text-xs text-destructive">{v.error}</p>}

                  {v.videoUrl && (
                    <>
                      <video src={v.videoUrl} controls className="w-full rounded-md bg-black max-h-[420px]" />
                      <a
                        href={v.videoUrl}
                        download
                        className="text-xs inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
                      >
                        <Download className="w-3.5 h-3.5" /> Download MP4
                      </a>
                    </>
                  )}

                  {!v.videoUrl && v.audioUrl && (
                    <audio src={v.audioUrl} controls className="w-full" />
                  )}
                </div>
              ))}
            </div>
          </main>
        </div>
      </div>
    </Layout>
  );
}
