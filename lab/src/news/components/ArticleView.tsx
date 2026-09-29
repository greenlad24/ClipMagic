import { formatDistanceToNow } from 'date-fns';
import { ExternalLink } from 'lucide-react';

interface Props {
  sourceName: string;
  sourceUrl?: string;
  publishedAt?: string;
  topicLabel: string;
  content: string;
  heroImageUrl?: string;
  large?: boolean;
}

export default function ArticleView({ sourceName, sourceUrl, publishedAt, topicLabel, content, heroImageUrl, large }: Props) {
  const timeAgo = publishedAt ? formatDistanceToNow(new Date(publishedAt), { addSuffix: true }) : '';

  return (
    <div className={`bg-card border border-border rounded-2xl ${large ? 'p-10 max-w-2xl mx-auto' : 'p-5'}`}>
      <div className="flex items-center gap-2 mb-4">
        <div className={`rounded bg-primary/10 px-2 py-0.5 font-medium text-primary ${large ? 'text-sm' : 'text-xs'}`}>
          {sourceName}
        </div>
        {timeAgo && <span className={`text-muted-foreground ${large ? 'text-sm' : 'text-xs'}`}>{timeAgo}</span>}
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className={large ? 'w-5 h-5' : 'w-4 h-4'} />
          </a>
        )}
      </div>
      {heroImageUrl && (
        <img
          src={heroImageUrl}
          alt="Article hero"
          className="w-full rounded-xl object-cover mb-4"
          style={{ maxHeight: large ? 360 : 200 }}
          onError={e => (e.currentTarget.style.display = 'none')}
        />
      )}
      <h2 className={`font-bold text-foreground leading-snug mb-3 ${large ? 'text-2xl' : 'text-base'}`}>{topicLabel}</h2>
      <p className={`text-foreground leading-relaxed ${large ? 'text-lg' : 'text-sm'}`}>{content}</p>
    </div>
  );
}
