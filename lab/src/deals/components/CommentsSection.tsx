import { useState } from 'react';
import { Comment, apiAddComment } from '@/deals/lib/supabase';
import { MessageSquare, Send } from 'lucide-react';
import { Textarea } from '@/deals/ui/textarea';
import { Button } from '@/deals/ui/button';
import { Skeleton } from '@/deals/ui/skeleton';
import RichText from './RichText';

interface CommentsSectionProps {
  dealId: string;
  comments: Comment[];
  loading: boolean;
  onCommentsChange: (comments: Comment[]) => void;
}

function Avatar({ name }: { name: string }) {
  const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div
      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
      style={{
        background: 'color-mix(in hsl, hsl(var(--primary)) 15%, transparent)',
        color: 'hsl(var(--primary))',
      }}
    >
      {initials}
    </div>
  );
}

export default function CommentsSection({ dealId, comments, loading, onCommentsChange }: CommentsSectionProps) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const handlePost = async () => {
    if (!text.trim()) return;
    setPosting(true);
    try {
      const comment = await apiAddComment(dealId, text.trim());
      onCommentsChange([...comments, comment]);
      setText('');
    } finally { setPosting(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare size={14} className="text-muted-foreground" />
        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Comments</span>
      </div>

      <div className="space-y-3 mb-3 max-h-64 overflow-y-auto pr-1 scrollbar-hide">
        {loading ? (
          [1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)
        ) : comments.length === 0 ? (
          <p className="text-xs text-muted-foreground/40 text-center py-3">No comments yet</p>
        ) : comments.map(c => (
          <div key={c.id} className="flex gap-2">
            <Avatar name={c.author} />
            <div className="glass-card rounded-lg px-3 py-2 flex-1">
              <p className="text-xs font-semibold text-foreground/80 mb-1">{c.author}</p>
              <p className="text-xs text-foreground/70 leading-relaxed">
                <RichText text={c.content} />
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Add context for the team..."
          rows={2}
          className="text-xs bg-muted/30 border-border/50 resize-none"
        />
        <Button
          size="sm"
          onClick={handlePost}
          disabled={posting || !text.trim()}
          className="w-full h-8 text-xs bg-primary text-primary-foreground"
        >
          <Send size={12} className="mr-1" /> Post comment
        </Button>
      </div>
    </div>
  );
}
