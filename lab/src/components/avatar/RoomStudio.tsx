import { useState } from 'react';
import { Grid3x3, Loader2, MapPin, Sparkles, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AvatarPersona } from 'zite-endpoints-sdk';

/**
 * MOVE A PERSONA INTO A ROOM.
 *
 * The panel exists because a persona and a set are separate things, and the
 * builder only ever let you fix them together at birth. This is the other
 * order: take a face that already works — including one made before rooms
 * existed — and photograph it somewhere else.
 *
 * TWO STEPS, DELIBERATELY SEPARATE. The sheet is generated once and reused by
 * every placement, so it is its own button rather than something that silently
 * happens on the first placement: it costs a generation, it is worth seeing
 * before you spend more on top of it, and a persona that already has one should
 * not quietly pay for another.
 *
 * The result is a PREVIEW, not an edit. Placing a persona somewhere new never
 * touches the persona it came from — you lock the result in as its own, so the
 * version that already worked survives the experiment.
 */

export interface RoomOption {
  id: string;
  label: string;
  hint: string;
  ready: boolean;
}

export interface RoomStudioProps {
  personas: AvatarPersona[];
  rooms: RoomOption[];
  /** The persona selected in the sidebar — this panel follows it. */
  personaId: string;
  onPersonaChange: (id: string) => void;
  onMakeSheet: (personaId: string) => Promise<void>;
  onPlace: (personaId: string, roomId: string) => Promise<void>;
  /** The placement waiting to be kept, if any. */
  placed: { url: string; usedSheet: boolean; roomId: string } | null;
  onKeep: () => void;
  onDiscard: () => void;
  sheeting: boolean;
  placing: boolean;
  disabled?: boolean;
}

export function RoomStudio({
  personas,
  rooms,
  personaId,
  onPersonaChange,
  onMakeSheet,
  onPlace,
  placed,
  onKeep,
  onDiscard,
  sheeting,
  placing,
  disabled,
}: RoomStudioProps) {
  const [roomId, setRoomId] = useState('');
  const persona = personas.find((p) => p.id === personaId) ?? null;
  const hasSheet = !!persona?.sheetUrl;
  const readyRooms = rooms.filter((r) => r.ready);
  const busy = sheeting || placing;

  if (personas.length === 0) return null;

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <MapPin className="h-4 w-4" /> Put a persona in a room
        </h2>
        <p className="text-xs text-muted-foreground">
          Photograph a face you already have somewhere else. The persona you started from is left untouched —
          the result is saved as its own.
        </p>
      </div>

      {/* Step 1 — who */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">1. Who</p>
        <div className="flex flex-wrap gap-1.5">
          {personas.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === personaId}
              disabled={busy}
              onClick={() => onPersonaChange(p.id)}
              className={cn(
                'flex items-center gap-2 rounded-md border p-1.5 pr-2.5 transition-colors',
                p.id === personaId ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40',
                busy && 'opacity-60',
              )}
            >
              <img src={p.portraitUrl} alt="" className="h-7 w-7 rounded object-cover bg-muted" />
              <span className="max-w-[9rem] truncate text-xs font-medium">{p.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Step 2 — the sheet. Its own step because it is generated once and then
          reused by every placement, and because seeing it is how you find out
          whether the face is going to hold. */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">2. Character sheet</p>
        {persona && hasSheet ? (
          <div className="space-y-2">
            <img
              src={persona.sheetUrl!}
              alt={`Twenty views of ${persona.name}`}
              className="w-full rounded border border-border bg-muted"
            />
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Check className="h-3 w-3 text-primary" /> Twenty angles on file
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={busy || disabled}
                onClick={() => void onMakeSheet(personaId)}
              >
                {sheeting ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                Rebuild
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              One portrait shows one angle, so a new room has to be invented around it — which is where a face
              drifts into someone else. Twenty views turn that into copying.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={!persona || busy || disabled}
              onClick={() => void onMakeSheet(personaId)}
            >
              {sheeting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Grid3x3 className="h-3 w-3" />}
              {sheeting ? 'Building the sheet…' : 'Make character sheet'}
            </Button>
          </div>
        )}
      </div>

      {/* Step 3 — where */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">3. Which room</p>
        {readyRooms.length === 0 ? (
          <p className="text-xs text-muted-foreground">No room plates on the server yet.</p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {readyRooms.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={r.id === roomId}
                disabled={busy}
                onClick={() => setRoomId(r.id)}
                className={cn(
                  'rounded-lg border p-2 text-left transition-colors',
                  r.id === roomId ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-muted-foreground/50',
                  busy && 'opacity-60',
                )}
              >
                <span className="block truncate text-xs font-medium text-foreground">{r.label}</span>
                <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                  {r.hint}
                </span>
              </button>
            ))}
          </div>
        )}
        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={!persona || !roomId || busy || disabled}
          onClick={() => void onPlace(personaId, roomId)}
        >
          {placing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {placing ? 'Placing them in the room…' : 'Place in room'}
        </Button>
        {!hasSheet && persona && (
          <p className="text-[11px] text-muted-foreground">
            You can place without a sheet — it just works from the single portrait, and the face is likelier to
            drift.
          </p>
        )}
      </div>

      {placed && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <img src={placed.url} alt="The persona placed in the room" className="w-full rounded border border-border" />
          <p className="text-[11px] text-muted-foreground">
            {placed.usedSheet
              ? 'Built from the twenty-view sheet.'
              : 'Built from the single portrait — make a sheet for a closer match.'}
          </p>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={onKeep} disabled={busy}>
              Save as a new persona
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onDiscard} disabled={busy}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
