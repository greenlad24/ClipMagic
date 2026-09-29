import { formatDistanceToNow } from 'date-fns';

interface Props {
  sourceName: string;
  sourceHandle?: string;
  publishedAt?: string;
  content: string;
  heroImageUrl?: string;
  large?: boolean;
}

export default function TweetView({ sourceName, sourceHandle, publishedAt, content, heroImageUrl, large }: Props) {
  const timeAgo = publishedAt ? formatDistanceToNow(new Date(publishedAt), { addSuffix: true }) : '';

  return (
    <div className={`bg-card border border-border rounded-2xl ${large ? 'p-10 max-w-2xl mx-auto' : 'p-5'}`}>
      <div className="flex items-center gap-3 mb-4">
        <div className={`rounded-full bg-muted flex items-center justify-center font-bold text-muted-foreground ${large ? 'w-12 h-12 text-lg' : 'w-9 h-9 text-sm'}`}>
          {sourceName.charAt(0).toUpperCase()}
        </div>
        <div>
          <p className={`font-semibold text-foreground ${large ? 'text-base' : 'text-sm'}`}>{sourceName}</p>
          {sourceHandle && (
            <p className={`text-muted-foreground ${large ? 'text-sm' : 'text-xs'}`}>
              @{sourceHandle} {timeAgo && `· ${timeAgo}`}
            </p>
          )}
        </div>
      </div>
      <p className={`text-foreground leading-relaxed whitespace-pre-wrap ${large ? 'text-xl' : 'text-sm'}`}>{content}</p>
      {heroImageUrl && (
        <img
          src={heroImageUrl}
          alt="Tweet media"
          className="mt-4 w-full rounded-xl object-cover"
          style={{ maxHeight: large ? 400 : 220 }}
          onError={e => (e.currentTarget.style.display = 'none')}
        />
      )}
    </div>
  );
}
