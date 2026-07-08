import { useEffect, useRef, useState } from 'react';
import {
  imageGeneratorStatus,
  generateChatImage,
} from 'zite-endpoints-sdk';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sparkles,
  Send,
  Settings,
  KeyRound,
  CheckCircle2,
  AlertTriangle,
  Download,
  Pencil,
  ImagePlus,
  X,
  Wand2,
} from 'lucide-react';

/**
 * AI Image Generator — a Nano Banana chat (LAB tool).
 *
 * Type a prompt in your own words; we optimize it into a strong image
 * instruction and generate an image. Attach reference images (or "Edit" a
 * result) to restyle / combine them instead of generating from scratch.
 *
 * EPHEMERAL BY DESIGN: images live only in React state (as data URLs) — nothing
 * is uploaded, saved to disk or written to a DB. Reloading the page clears the
 * whole conversation. Uses the same Gemini key as the Thumbnail Designer.
 */

type ChatModel = 'flash' | 'pro' | 'flash-31';
type ChatAspect = 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

const MODEL_OPTIONS: { value: ChatModel; label: string; hint: string }[] = [
  { value: 'flash', label: 'Nano Banana (fast)', hint: 'Gemini 2.5 Flash Image — quick & cheap' },
  { value: 'pro', label: 'Nano Banana Pro (sharpest)', hint: 'Gemini 3 Pro Image — best quality, slower' },
  { value: 'flash-31', label: 'Nano Banana 3.1', hint: 'Gemini 3.1 Flash Image — newer, fast' },
];

const ASPECT_OPTIONS: ChatAspect[] = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'];

/** A reference image the user attached (or pulled from a previous result). */
interface RefImage {
  base64: string;
  mimeType: string;
  dataUrl: string;
}

interface UserMessage {
  role: 'user';
  text: string;
  refs: RefImage[];
}

interface AssistantMessage {
  role: 'assistant';
  dataUrl?: string;
  mimeType?: string;
  base64?: string;
  promptUsed?: string;
  optimized?: boolean;
  modelLabel?: string;
  error?: string;
}

type ChatMessage = UserMessage | AssistantMessage;

function toDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/** Read a File into { base64, mimeType, dataUrl } without uploading anything. */
function readImageFile(file: File): Promise<RefImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) {
        reject(new Error(`${file.name} is not a supported image`));
        return;
      }
      resolve({ mimeType: m[1], base64: m[2], dataUrl });
    };
    reader.readAsDataURL(file);
  });
}

export default function ImageGeneratorPage() {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [optimizerConfigured, setOptimizerConfigured] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<ChatModel>('flash');
  const [aspect, setAspect] = useState<ChatAspect>('auto');
  const [optimize, setOptimize] = useState(true);
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    imageGeneratorStatus({})
      .then((s) => {
        setGeminiConfigured(!!s.geminiConfigured);
        setOptimizerConfigured(!!s.promptOptimizerConfigured);
      })
      .catch(() => {
        setGeminiConfigured(false);
        setOptimizerConfigured(false);
      })
      .finally(() => setLoadingStatus(false));
  }, []);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    try {
      const read = await Promise.all(Array.from(files).map(readImageFile));
      setRefs((prev) => [...prev, ...read].slice(0, 6));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read image');
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  function removeRef(idx: number) {
    setRefs((prev) => prev.filter((_, i) => i !== idx));
  }

  /** Feed a generated image back in as a reference to edit / iterate on it. */
  function editImage(m: AssistantMessage) {
    if (!m.base64 || !m.mimeType || !m.dataUrl) return;
    setRefs([{ base64: m.base64, mimeType: m.mimeType, dataUrl: m.dataUrl }]);
    toast.success('Loaded as a reference — describe the change you want.');
  }

  async function send() {
    const text = prompt.trim();
    if (!text || busy) return;
    const sentRefs = refs;

    setMessages((prev) => [...prev, { role: 'user', text, refs: sentRefs }]);
    setPrompt('');
    setRefs([]);
    setBusy(true);

    try {
      const res = await generateChatImage({
        prompt: text,
        images: sentRefs.map((r) => ({ base64: r.base64, mimeType: r.mimeType })),
        model,
        aspect,
        optimize,
      });
      const dataUrl = toDataUrl(res.image.mimeType, res.image.base64);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          dataUrl,
          mimeType: res.image.mimeType,
          base64: res.image.base64,
          promptUsed: res.prompt,
          optimized: res.optimized,
          modelLabel: res.modelLabel,
        },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Image generation failed';
      setMessages((prev) => [...prev, { role: 'assistant', error: message }]);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function onPromptKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const editing = refs.length > 0;

  return (
    <Layout breadcrumb="AI Image Generator">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 flex flex-col" style={{ minHeight: 'calc(100vh - 57px)' }}>
        <header className="mb-4">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-[hsl(var(--chart-2))]/10 p-2 text-[hsl(var(--chart-2))]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">AI Image Generator</h1>
              <p className="text-xs text-muted-foreground">
                Nano Banana chat — describe an image or attach photos to edit. Nothing is saved; reloading clears the chat.
              </p>
            </div>
          </div>
        </header>

        {loadingStatus ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-2/3" />
          </div>
        ) : !geminiConfigured ? (
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-[hsl(var(--chart-5))]/10 p-2 text-[hsl(var(--chart-5))]">
                <KeyRound className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <h2 className="font-semibold text-foreground">Connect your Gemini key</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  The image generator uses Nano Banana (Google Gemini image models). Add your Gemini key — the same one
                  the Thumbnail Designer uses — to start generating. It's stored write-only on the server.
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Badge variant="secondary" className="gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    Gemini not set
                  </Badge>
                  <Button asChild variant="outline" size="sm" className="ml-auto">
                    <Link to="/settings/postiz">
                      <Settings className="w-4 h-4" />
                      Configure key
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <>
            {/* Conversation */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pb-4">
              {messages.length === 0 && (
                <div className="text-center text-muted-foreground py-12">
                  <Sparkles className="w-8 h-8 mx-auto mb-3 opacity-40" />
                  <p className="text-sm">Describe the image you want, or attach photos to edit or combine.</p>
                  <p className="text-xs mt-1 opacity-70">e.g. "a cozy reading nook at golden hour, soft film grain"</p>
                </div>
              )}

              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5">
                      {m.refs.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {m.refs.map((r, ri) => (
                            <img
                              key={ri}
                              src={r.dataUrl}
                              alt="reference"
                              className="w-12 h-12 rounded object-cover border border-primary-foreground/30"
                            />
                          ))}
                        </div>
                      )}
                      <p className="text-sm whitespace-pre-wrap">{m.text}</p>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-card border border-border overflow-hidden">
                      {m.error ? (
                        <div className="px-4 py-3 flex items-start gap-2 text-destructive">
                          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                          <p className="text-sm">{m.error}</p>
                        </div>
                      ) : (
                        <div>
                          <img src={m.dataUrl} alt="generated" className="w-full max-w-md" />
                          <div className="px-3 py-2 space-y-2">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {m.modelLabel && (
                                <Badge variant="secondary" className="text-[10px] gap-1">
                                  <Sparkles className="w-3 h-3" />
                                  {m.modelLabel}
                                </Badge>
                              )}
                              {m.optimized && (
                                <Badge variant="secondary" className="text-[10px] gap-1">
                                  <Wand2 className="w-3 h-3" />
                                  Prompt optimized
                                </Badge>
                              )}
                            </div>
                            {m.promptUsed && (
                              <p className="text-[11px] text-muted-foreground italic line-clamp-3">{m.promptUsed}</p>
                            )}
                            <div className="flex items-center gap-2">
                              <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                                <a href={m.dataUrl} download={`nano-banana.${(m.mimeType || 'image/png').split('/')[1] || 'png'}`}>
                                  <Download className="w-3.5 h-3.5" />
                                  Download
                                </a>
                              </Button>
                              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => editImage(m)}>
                                <Pencil className="w-3.5 h-3.5" />
                                Edit this
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}

              {busy && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-sm bg-card border border-border px-4 py-3 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[hsl(var(--chart-2))] animate-pulse" />
                    <span className="text-sm text-muted-foreground">Generating your image…</span>
                  </div>
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="sticky bottom-0 pt-2 bg-background">
              {refs.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {refs.map((r, i) => (
                    <div key={i} className="relative">
                      <img src={r.dataUrl} alt="attachment" className="w-14 h-14 rounded-md object-cover border border-border" />
                      <button
                        onClick={() => removeRef(i)}
                        className="absolute -top-1.5 -right-1.5 bg-background border border-border rounded-full p-0.5 hover:bg-muted"
                        aria-label="Remove image"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-xl border border-border bg-card p-2">
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={onPromptKeyDown}
                  placeholder={editing ? 'Describe the change to make to the attached image…' : 'Describe the image you want…'}
                  rows={2}
                  className="border-0 focus-visible:ring-0 resize-none bg-transparent"
                />
                <div className="flex items-center gap-2 flex-wrap pt-1">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => fileRef.current?.click()}
                    disabled={refs.length >= 6}
                    title="Attach reference image(s) to edit or combine"
                  >
                    <ImagePlus className="w-4 h-4" />
                  </Button>

                  <Select value={model} onValueChange={(v) => setModel(v as ChatModel)}>
                    <SelectTrigger className="h-8 w-auto gap-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value} className="text-xs">
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select value={aspect} onValueChange={(v) => setAspect(v as ChatAspect)}>
                    <SelectTrigger className="h-8 w-auto gap-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASPECT_OPTIONS.map((a) => (
                        <SelectItem key={a} value={a} className="text-xs">
                          {a === 'auto' ? 'Auto ratio' : a}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Button
                    variant={optimize ? 'secondary' : 'outline'}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setOptimize((v) => !v)}
                    disabled={!optimizerConfigured}
                    title={
                      optimizerConfigured
                        ? 'Rewrite your words into a stronger prompt before generating'
                        : 'Prompt optimizer needs an Anthropic key (Settings)'
                    }
                  >
                    <Wand2 className="w-3.5 h-3.5" />
                    {optimize && optimizerConfigured ? 'Optimize: on' : 'Optimize: off'}
                  </Button>

                  <Button className="h-8 ml-auto" size="sm" onClick={send} disabled={busy || !prompt.trim()}>
                    <Send className="w-4 h-4" />
                    Generate
                  </Button>
                </div>
              </div>
              {!optimizerConfigured && (
                <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  Add an Anthropic key in Settings to auto-optimize your prompts.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
