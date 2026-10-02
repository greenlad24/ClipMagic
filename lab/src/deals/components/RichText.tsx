/** Renders plain text with auto-detected URLs as clickable links, inline images, and YouTube/Loom embeds. */

const URL_REGEX = /(https?:\/\/[^\s<>"')\]]+)/g;

function isImageUrl(url: string) {
  return /\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i.test(url.split('?')[0]);
}

function getYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
  } catch { /* */ }
  return null;
}

function getLoomId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('loom.com')) {
      const m = u.pathname.match(/\/(share|embed)\/([a-zA-Z0-9]+)/);
      return m?.[2] ?? null;
    }
  } catch { /* */ }
  return null;
}

interface RichTextProps {
  text: string;
  className?: string;
}

export default function RichText({ text, className }: RichTextProps) {
  const parts = text.split(URL_REGEX);

  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (!part.match(/^https?:\/\//)) return <span key={i}>{part}</span>;

        const ytId = getYouTubeId(part);
        if (ytId) {
          return (
            <span key={i} className="block my-2">
              <a
                href={part}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-primary underline underline-offset-2 hover:opacity-75 text-xs break-all"
              >
                ▶ {part}
              </a>
              <iframe
                src={`https://www.youtube.com/embed/${ytId}`}
                className="w-full rounded-lg mt-1.5"
                style={{ aspectRatio: '16/9' }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                loading="lazy"
                title="YouTube embed"
              />
            </span>
          );
        }

        const loomId = getLoomId(part);
        if (loomId) {
          return (
            <span key={i} className="block my-2">
              <a
                href={part}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-primary underline underline-offset-2 hover:opacity-75 text-xs break-all"
              >
                ▶ {part}
              </a>
              <iframe
                src={`https://www.loom.com/embed/${loomId}`}
                className="w-full rounded-lg mt-1.5"
                style={{ aspectRatio: '16/9' }}
                allowFullScreen
                loading="lazy"
                title="Loom embed"
              />
            </span>
          );
        }

        if (isImageUrl(part)) {
          return (
            <span key={i} className="block my-2">
              <img
                src={part}
                alt="attachment"
                className="max-w-full rounded-lg"
                loading="lazy"
                style={{ maxHeight: '300px', objectFit: 'contain' }}
                onError={e => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </span>
          );
        }

        return (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:opacity-75 break-all"
          >
            {part}
          </a>
        );
      })}
    </span>
  );
}
