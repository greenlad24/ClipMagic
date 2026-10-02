import { Sparkles, ExternalLink } from 'lucide-react';
import { Deal } from '@/deals/lib/supabase';
import { useStageLabels } from '@/deals/context/StageLabelsContext';

function extractNextSteps(description: string | null | undefined): string {
  if (!description) return '';
  const match = description.match(/\*\*Next Steps:\*\*\s*(.+?)(?=\n\n|\*\*|$)/s);
  return match?.[1]?.trim() ?? '';
}

export default function AiInsightSection({ deal }: { deal: Deal }) {
  const nextSteps = extractNextSteps(deal.description);
  // Live stage label + colour (custom and renamed stages included).
  const { getStageLabel, getStageColor } = useStageLabels();
  const stageColor = deal.stage ? getStageColor(deal.stage) : null;

  return (
    <div
      className="mb-5 flex-shrink-0"
      style={{
        background: 'var(--ai-card-bg)',
        border: '1px solid var(--ai-card-border)',
        borderRadius: 12,
        padding: '16px 18px',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2.5">
        <Sparkles size={15} style={{ color: 'hsl(var(--primary))' }} />
        <span className="text-[14px] font-semibold text-foreground">What should I do now?</span>
      </div>

      {/* Body */}
      {nextSteps ? (
        <p className="text-[14px] leading-relaxed mb-3" style={{ color: 'var(--text-primary)' }}>
          {nextSteps}
        </p>
      ) : (
        <p className="text-[14px] italic text-muted-foreground mb-3">
          Run a Gmail scan to generate AI insights for this deal.
        </p>
      )}

      {/* Tags row */}
      <div className="flex items-center gap-2 flex-wrap">
        {deal.stage && stageColor && (
          <span
            className="text-[12px] font-medium px-2.5 py-1 rounded-full"
            style={{ background: `color-mix(in hsl, ${stageColor} 15%, transparent)`, color: stageColor }}
          >
            Stage: {getStageLabel(deal.stage, deal.stage)}
          </span>
        )}
        {deal.thread_link && (
          <a
            href={deal.thread_link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-full"
            style={{
              background: 'hsl(var(--muted))',
              color: 'hsl(var(--muted-foreground))',
              textDecoration: 'none',
            }}
          >
            <ExternalLink size={11} />
            Open Gmail Thread
          </a>
        )}
      </div>
    </div>
  );
}
