import { useState } from 'react';
import { toast } from 'sonner';
import {
  tutorialAvatarSpec,
  tutorialAvatarDraw,
  tutorialAvatarRefine,
  tutorialAvatarMap,
  tutorialAvatarScene,
  tutorialAvatarCreate,
  type TutorialPersonaEngine,
  type TutorialCaptureLook,
  type TutorialPersonaSpec,
} from 'zite-endpoints-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Sparkles, Upload, Wand2, RotateCcw, Save, X, Grid3x3, Home } from 'lucide-react';

/**
 * Make an avatar instead of uploading one.
 *
 * The flow is deliberately four steps rather than one button, because each step
 * fails differently and each one costs money:
 *
 *   describe → the sentence (and any reference photo) becomes a written spec
 *   draw     → the spec becomes a portrait
 *   refine   → the portrait goes back through the model, identity locked
 *   save     → only then does anything reach the avatar library
 *
 * The spec is shown and EDITABLE because that is where realism is actually won.
 * "Brown hair" is an average and averages are what make a face look generated;
 * fixing a word here is far cheaper than rolling the image again hoping.
 */

/** Label + how many rows the field deserves, in the order they read best. */
const FIELDS: Array<{ key: keyof TutorialPersonaSpec; label: string; rows: number }> = [
  { key: 'age', label: 'Age', rows: 1 },
  { key: 'presenting', label: 'Presenting as', rows: 1 },
  { key: 'heritage', label: 'Heritage / colouring', rows: 1 },
  { key: 'build', label: 'Build', rows: 2 },
  { key: 'demeanour', label: 'Posture and energy', rows: 2 },
  { key: 'face', label: 'Face — the bone structure', rows: 3 },
  { key: 'eyes', label: 'Eyes and brows', rows: 3 },
  { key: 'hair', label: 'Hair', rows: 3 },
  { key: 'skin', label: 'Skin (where realism lives)', rows: 3 },
  { key: 'wardrobe', label: 'Wearing', rows: 2 },
  { key: 'imperfections', label: 'Ordinary imperfections', rows: 2 },
];

/** Kept in step with the sidecar's MAX_AVATAR_BYTES. */
const MAX_BYTES = 12 * 1024 * 1024;

export default function AvatarMaker({
  engines,
  captures,
  canDescribe,
  onCreated,
}: {
  engines: TutorialPersonaEngine[];
  captures: TutorialCaptureLook[];
  canDescribe: boolean;
  onCreated: () => void;
}) {
  const [sentence, setSentence] = useState('');
  const [environment, setEnvironment] = useState('');
  const [reference, setReference] = useState<{ b64: string; name: string } | null>(null);
  const [engineId, setEngineId] = useState('');
  const [captureId, setCaptureId] = useState('');

  const [spec, setSpec] = useState<TutorialPersonaSpec | null>(null);
  const [image, setImage] = useState<string | null>(null);
  // The two deliverables: the three-panel identity map, and that same person in
  // the room she talks from. The scene is what the pipeline renders reels from;
  // the map is the identity asset kept beside it.
  const [map, setMap] = useState<string | null>(null);
  const [scene, setScene] = useState<string | null>(null);
  const [plate, setPlate] = useState<{ b64: string; name: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [refineNotes, setRefineNotes] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');

  // An engine whose key is missing is not offerable; fall back to the first
  // that is ready so the primary button never fails on a configuration problem
  // the operator can see on screen.
  const usable = engines.filter((e) => e.ready);
  const engine = usable.find((e) => e.id === engineId) || usable[0] || null;
  const capture = captures.find((c) => c.id === captureId) || captures[0] || null;

  function pickReference(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_BYTES) {
      toast.error(`That image is ${(f.size / 1024 / 1024).toFixed(1)}MB — the limit is 12MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setReference({ b64: String(reader.result || ''), name: f.name });
    reader.onerror = () => toast.error('Could not read that file.');
    reader.readAsDataURL(f);
  }

  /** describe → draw, the one button that answers "make me this person". */
  async function create() {
    if (!sentence.trim() && !reference) {
      toast.error('Say who you want, or add a reference photo.');
      return;
    }
    setBusy('create');
    try {
      const { spec: written } = await tutorialAvatarSpec({
        sentence: sentence.trim() || undefined,
        referenceBase64: reference?.b64,
        environment: environment.trim() || undefined,
      });
      setSpec(written);
      await draw(written);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not describe that person.');
    } finally {
      setBusy('');
    }
  }

  async function draw(useSpec?: TutorialPersonaSpec) {
    const s = useSpec || spec;
    if (!s) return;
    const own = !useSpec; // called on its own, so it owns the busy flag
    if (own) setBusy('draw');
    try {
      const res = await tutorialAvatarDraw({
        spec: s,
        environment: environment.trim() || undefined,
        captureId: capture?.id,
        engineId: engine?.id,
        referenceBase64: reference?.b64,
      });
      setImage(res.imageBase64);
      setPrompt(res.prompt);
      // A new face makes the old map and scene wrong, and a stale map is worse
      // than none — it would save an avatar whose panels are someone else.
      setMap(null);
      setScene(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not draw that person.');
      if (!own) throw err;
    } finally {
      if (own) setBusy('');
    }
  }

  async function refine() {
    if (!image) return;
    setBusy('refine');
    try {
      const res = await tutorialAvatarRefine({
        imageBase64: image,
        notes: refineNotes.trim() || undefined,
        engineId: engine?.id,
      });
      setImage(res.imageBase64);
      setPrompt(res.prompt);
      setRefineNotes('');
      toast.success('Refined — compare it against the last roll before saving.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refine that image.');
    } finally {
      setBusy('');
    }
  }

  async function buildMap() {
    if (!image) return;
    setBusy('map');
    try {
      const res = await tutorialAvatarMap({ imageBase64: image, engineId: engine?.id });
      setMap(res.imageBase64);
      setPrompt(res.prompt);
      toast.success('Avatar map built.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the map.');
    } finally {
      setBusy('');
    }
  }

  async function buildScene() {
    // The map is the better identity input — it shows the model the angles a
    // single portrait cannot. The portrait is the fallback before one exists.
    const identity = map || image;
    if (!identity) return;
    setBusy('scene');
    try {
      const res = await tutorialAvatarScene({
        mapBase64: identity,
        plateBase64: plate?.b64,
        environment: environment.trim() || undefined,
        captureId: capture?.id,
        engineId: engine?.id,
      });
      setScene(res.imageBase64);
      setPrompt(res.prompt);
      toast.success(
        res.usedPlate
          ? 'Placed in your room — the light is inherited from the photo.'
          : 'Placed in the described room.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not place her in the room.');
    } finally {
      setBusy('');
    }
  }

  function pickPlate(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_BYTES) {
      toast.error(`That image is ${(f.size / 1024 / 1024).toFixed(1)}MB — the limit is 12MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPlate({ b64: String(reader.result || ''), name: f.name });
    reader.onerror = () => toast.error('Could not read that file.');
    reader.readAsDataURL(f);
  }

  async function save() {
    // The SCENE is what the pipeline re-renders start frames from — she is
    // already in her room under its light — so it is the reference when there
    // is one, and the plain portrait is the fallback.
    const ref = scene || image;
    if (!ref) return;
    if (!name.trim()) {
      toast.error('Give the avatar a name.');
      return;
    }
    setBusy('save');
    try {
      await tutorialAvatarCreate({
        name: name.trim(),
        environment: environment.trim(),
        imageBase64: ref,
        mapBase64: map || undefined,
      });
      toast.success(map ? 'Saved, with its avatar map.' : 'Saved to the avatar library.');
      setImage(null);
      setMap(null);
      setScene(null);
      setSpec(null);
      setName('');
      setSentence('');
      setReference(null);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the avatar.');
    } finally {
      setBusy('');
    }
  }

  const working = Boolean(busy);

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-chart-2" />
        <h3 className="font-semibold">Make one</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Describe who you want in a sentence and this writes them out in full, then draws
        them. Add a photo of someone and it takes their <em>type</em> — age, colouring,
        build, hair, the way they dress — and builds a different person who reads the same
        way.
      </p>

      {!canDescribe && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
          No Anthropic key, so the describing step can't run. Add one in Settings.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="who">Who do you want?</Label>
          <Textarea
            id="who"
            rows={2}
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            placeholder="a 30-something British woman who looks like a product designer, warm and a bit tired"
            className="mt-1.5"
          />
        </div>

        <div>
          <Label>Reference photo (optional)</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent">
              <Upload className="h-3.5 w-3.5" />
              {reference ? 'Change' : 'Choose a photo'}
              <input type="file" accept="image/*" className="hidden" onChange={pickReference} />
            </label>
            {reference && (
              <>
                <img src={reference.b64} alt="" className="h-10 w-10 rounded object-cover" />
                <Button variant="ghost" size="sm" onClick={() => setReference(null)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Used for the type only. The face that comes out is deliberately a different
            person — same kind of person, not the same one.
          </p>
        </div>

        <div>
          <Label htmlFor="env">Where they're always filmed</Label>
          <Input
            id="env"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            placeholder="a warm cozy home with plants and wooden shelves"
            className="mt-1.5"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Saved with the avatar: every video is a different corner of this one place.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <div>
          <Label className="text-xs text-muted-foreground">Drawn by</Label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {engines.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={!e.ready}
                title={e.ready ? e.hint : `${e.hint} — its API key is not set.`}
                onClick={() => setEngineId(e.id)}
                className={`rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-40 ${
                  engine?.id === e.id ? 'border-primary bg-primary/10' : 'border-border'
                }`}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Shot like</Label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {captures.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.hint}
                onClick={() => setCaptureId(c.id)}
                className={`rounded-md border px-2.5 py-1.5 text-xs ${
                  capture?.id === c.id ? 'border-primary bg-primary/10' : 'border-border'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <Button className="ml-auto" onClick={create} disabled={working || !canDescribe || !engine}>
          {busy === 'create' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Making them…
            </>
          ) : (
            <>
              <Wand2 className="mr-2 h-4 w-4" /> Create the person
            </>
          )}
        </Button>
      </div>

      {spec && (
        <div className="mt-5 border-t border-border/60 pt-4">
          <div className="flex items-center justify-between">
            <Label>Who they are, written out</Label>
            <Button variant="ghost" size="sm" onClick={() => void draw()} disabled={working}>
              {busy === 'draw' ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-3.5 w-3.5" />
              )}
              Draw again
            </Button>
          </div>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">
            Edit any of this and draw again — changing a word is far cheaper than rolling the
            image and hoping. Skin and the imperfections are what stop it looking generated.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key} className={f.rows > 2 ? 'sm:col-span-1' : ''}>
                <Label className="text-xs text-muted-foreground">{f.label}</Label>
                <Textarea
                  rows={f.rows}
                  value={spec[f.key]}
                  onChange={(e) => setSpec({ ...spec, [f.key]: e.target.value })}
                  className="mt-1 text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {image && (
        <div className="mt-5 grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-[240px_1fr]">
          <img
            src={image}
            alt="The generated avatar"
            className="w-full rounded-md border border-border bg-black object-cover"
          />
          <div className="space-y-3">
            <div>
              <Label htmlFor="refine">Anything to fix?</Label>
              <Input
                id="refine"
                value={refineNotes}
                onChange={(e) => setRefineNotes(e.target.value)}
                placeholder="the light on her face is too even; let the room's window carry it"
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Refining keeps the same person and only changes how it was photographed —
                skin texture, asymmetry, light that belongs to the room, real grain.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={refine} disabled={working}>
                {busy === 'refine' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Refine for realism
              </Button>
              <Button variant="ghost" onClick={() => void draw()} disabled={working}>
                Roll a different face
              </Button>
            </div>
            {prompt && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">The exact prompt used</summary>
                <p className="mt-2 whitespace-pre-wrap leading-relaxed">{prompt}</p>
              </details>
            )}
          </div>
        </div>
      )}

      {image && (
        <div className="mt-5 space-y-4 border-t border-border/60 pt-4">
          {/* ── 1. the avatar map ── */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Grid3x3 className="h-4 w-4 text-chart-2" />
              <span className="font-medium">Avatar map</span>
              <span className="text-xs text-muted-foreground">
                close-up · standing front · back of the body
              </span>
              <Button
                variant={map ? 'ghost' : 'secondary'}
                size="sm"
                className="ml-auto"
                onClick={buildMap}
                disabled={working}
              >
                {busy === 'map' ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Grid3x3 className="mr-2 h-3.5 w-3.5" />
                )}
                {map ? 'Build it again' : 'Build the map'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              One photograph shows a body from one angle, so everything downstream has to
              invent the rest — and inventing is where the face drifts. The map gives it the
              angles instead.
            </p>
            {map && (
              <img
                src={map}
                alt="The three-panel avatar map"
                className="mt-2 w-full rounded-md border border-border bg-black"
              />
            )}
          </div>

          {/* ── 2. that person, in the room she talks from ── */}
          <div className="border-t border-border/60 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Home className="h-4 w-4 text-chart-2" />
              <span className="font-medium">In her room</span>
              <Button
                variant={scene ? 'ghost' : 'secondary'}
                size="sm"
                className="ml-auto"
                onClick={buildScene}
                disabled={working}
              >
                {busy === 'scene' ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Home className="mr-2 h-3.5 w-3.5" />
                )}
                {scene ? 'Shoot it again' : 'Put her in the room'}
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent">
                <Upload className="h-3.5 w-3.5" />
                {plate ? 'Change the room photo' : 'Add a photo of the room'}
                <input type="file" accept="image/*" className="hidden" onChange={pickPlate} />
              </label>
              {plate && (
                <>
                  <img src={plate.b64} alt="" className="h-10 w-10 rounded object-cover" />
                  <Button variant="ghost" size="sm" onClick={() => setPlate(null)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {plate
                ? 'The room and its light are taken from your photo, not described — that is what makes the lighting real rather than plausible.'
                : `Without a photo the room is generated from its description${
                    environment.trim() ? '' : ' (add one above)'
                  }. A photo of the actual room gives you its real light instead.`}
            </p>
            {scene && (
              <img
                src={scene}
                alt="The avatar in her room"
                className="mt-2 max-h-[420px] rounded-md border border-border bg-black"
              />
            )}
          </div>

          {/* ── 3. save ── */}
          <div className="flex flex-wrap items-end gap-2 border-t border-border/60 pt-4">
            <div className="flex-1">
              <Label htmlFor="avname">Name</Label>
              <Input
                id="avname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mia"
                className="mt-1.5"
              />
            </div>
            <Button onClick={save} disabled={working}>
              {busy === 'save' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save as an avatar
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {scene
              ? 'Saves the room shot as the avatar the reels render from'
              : 'Saves the portrait as the avatar the reels render from'}
            {map ? ', with the map kept beside it.' : '. No map yet — build one above to keep it too.'}
          </p>
        </div>
      )}
    </div>
  );
}
