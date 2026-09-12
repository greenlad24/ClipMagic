import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  tutorialAvatars,
  tutorialAvatarCreate,
  tutorialAvatarUpdate,
  tutorialAvatarDelete,
  type TutorialAvatar,
  type TutorialPersonaEngine,
  type TutorialCaptureLook,
} from 'zite-endpoints-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Trash2, Upload, Save } from 'lucide-react';
import AvatarMaker from './AvatarMaker';

/**
 * The avatar library: start images the operator made themselves.
 *
 * An avatar is an IDENTITY reference, not a frame that gets used as-is. Every
 * video re-generates the start frame from it, holding the face 1:1 while the
 * outfit and the corner of the room change — which is why each avatar also
 * carries the ONE environment its videos are shot in.
 */

/** Kept in step with the sidecar's MAX_AVATAR_BYTES. */
const MAX_BYTES = 12 * 1024 * 1024;

export function avatarImageUrl(id: string): string {
  return `/api/tutorial/avatar/${encodeURIComponent(id)}.img`;
}

/** The three-panel identity map, for avatars that were built rather than uploaded. */
export function avatarMapUrl(id: string): string {
  return `/api/tutorial/avatar/${encodeURIComponent(id)}.map`;
}

export default function AvatarLibrary({
  onChange,
  engines = [],
  captures = [],
  canDescribe = false,
}: {
  /** Told after any create/delete so a parent picker can refresh. */
  onChange?: () => void;
  /** The maker's catalogue, from tutorialStudioStatus (the page already has it). */
  engines?: TutorialPersonaEngine[];
  captures?: TutorialCaptureLook[];
  canDescribe?: boolean;
}) {
  const [avatars, setAvatars] = useState<TutorialAvatar[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [file, setFile] = useState<{ b64: string; preview: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { avatars: list } = await tutorialAvatars({});
      setAvatars(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load avatars.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_BYTES) {
      toast.error(`That image is ${(f.size / 1024 / 1024).toFixed(1)}MB — the limit is 12MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setFile({ b64: dataUrl, preview: dataUrl, name: f.name });
      if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, ''));
    };
    reader.onerror = () => toast.error('Could not read that file.');
    reader.readAsDataURL(f);
  }

  async function create() {
    if (!file) {
      toast.error('Choose a start image first.');
      return;
    }
    if (!name.trim()) {
      toast.error('Give the avatar a name.');
      return;
    }
    setSaving(true);
    try {
      await tutorialAvatarCreate({
        name: name.trim(),
        environment: environment.trim(),
        imageBase64: file.b64,
      });
      toast.success('Avatar added.');
      setFile(null);
      setName('');
      setEnvironment('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
      onChange?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the avatar.');
    } finally {
      setSaving(false);
    }
  }

  async function saveEnvironment(a: TutorialAvatar) {
    const next = drafts[a.id];
    if (next === undefined) return;
    try {
      await tutorialAvatarUpdate({ id: a.id, environment: next });
      setDrafts((d) => {
        const { [a.id]: _drop, ...rest } = d;
        return rest;
      });
      toast.success('Saved.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    }
  }

  async function remove(a: TutorialAvatar) {
    if (!window.confirm(`Delete "${a.name}"? Batches already rendered keep their videos.`)) return;
    try {
      await tutorialAvatarDelete({ id: a.id });
      toast.success('Deleted.');
      await load();
      onChange?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    }
  }

  return (
    <div className="space-y-6">
      {engines.length > 0 && (
        <AvatarMaker
          engines={engines}
          captures={captures}
          canDescribe={canDescribe}
          onCreated={() => {
            void load();
            onChange?.();
          }}
        />
      )}

      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="mb-1 font-medium">Or upload one</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          A start image you made yourself. Her face is kept exactly as uploaded; the
          outfit and the corner of the room change on every video.
        </p>
        <div className="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
          <div>
            <div className="mb-2 flex aspect-[9/16] items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-background/40">
              {file ? (
                <img src={file.preview} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="px-2 text-center text-xs text-muted-foreground">
                  9:16 start image
                </span>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={pick}
              className="hidden"
              id="avatar-file"
            />
            <Button variant="outline" size="sm" className="w-full" asChild>
              <label htmlFor="avatar-file" className="cursor-pointer">
                <Upload className="mr-2 h-4 w-4" /> Choose image
              </label>
            </Button>
          </div>
          <div className="space-y-3">
            <div>
              <Label htmlFor="avatar-name">Name</Label>
              <Input
                id="avatar-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Mia — home office"
              />
            </div>
            <div>
              <Label htmlFor="avatar-env">The room every video is shot in</Label>
              <Textarea
                id="avatar-env"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                rows={3}
                placeholder="e.g. a cozy home office with a light-wood desk, a shelf of books and a big window to her left"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Describe the place in your image. Every video is a different corner of it, so
                the whole batch reads as one person filming at home.
              </p>
            </div>
            <Button onClick={create} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Adding…
                </>
              ) : (
                'Add avatar'
              )}
            </Button>
          </div>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading avatars…</p>
      ) : avatars.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No avatars yet. Without one, reels use the packaged creator look.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {avatars.map((a) => (
            <div key={a.id} className="rounded-lg border border-border bg-card p-3">
              <img
                src={avatarImageUrl(a.id)}
                alt={a.name}
                className="mb-3 aspect-[9/16] w-full rounded-md object-cover"
              />
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(a.bytes / 1024).toFixed(0)} KB
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => remove(a)}>
                  <Trash2 className="h-4 w-4 text-red-400" />
                </Button>
              </div>
              <Textarea
                rows={3}
                value={drafts[a.id] ?? a.environment}
                onChange={(e) => setDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                placeholder="The room every video is shot in"
                className="text-xs"
              />
              {drafts[a.id] !== undefined && drafts[a.id] !== a.environment && (
                <Button size="sm" className="mt-2" onClick={() => void saveEnvironment(a)}>
                  <Save className="mr-2 h-3.5 w-3.5" /> Save
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
