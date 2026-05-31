import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { Trash2, CheckCircle2 } from 'lucide-react';
import { GetProjectsOutputType } from 'zite-endpoints-sdk';

type Project = GetProjectsOutputType['projects'][0];

const STATUS_STYLES: Record<string, string> = {
  Complete: 'bg-primary/15 text-primary',
  Capturing: 'bg-blue-500/15 text-blue-400',
  Rendering: 'bg-blue-500/15 text-blue-400',
  Directing: 'bg-yellow-500/15 text-yellow-400',
  Transcribing: 'bg-yellow-500/15 text-yellow-400',
  Uploading: 'bg-muted text-muted-foreground',
  Error: 'bg-destructive/15 text-destructive',
};

interface ProjectCardProps {
  project: Project;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onDeleteSingle?: (id: string) => void;
}

export default function ProjectCard({
  project,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onDeleteSingle,
}: ProjectCardProps) {
  const navigate = useNavigate();

  const goToProcessing = ['Uploading', 'Transcribing', 'Directing', 'Capturing', 'Rendering'].includes(
    project.status ?? ''
  );
  const href = goToProcessing
    ? `/project/${project.id}/processing`
    : `/project/${project.id}/preview`;

  const handleClick = () => {
    if (selectionMode) {
      onToggleSelect?.(project.id);
    } else {
      navigate(href);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`border rounded-xl overflow-hidden bg-card transition-all cursor-pointer group relative
        ${selectionMode && selected
          ? 'border-primary ring-2 ring-primary/30'
          : 'border-border hover:border-primary/40'
        }`}
    >
      {/* Thumbnail */}
      <div className="w-full h-32 bg-muted flex items-center justify-center relative">
        <div className="absolute inset-0 bg-gradient-to-t from-card/60 to-transparent" />
        <span className="text-3xl">🎬</span>

        {(project.status === 'Transcribing' || project.status === 'Directing') && (
          <div className="absolute bottom-2 left-2 right-2">
            <div className="h-0.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full animate-pulse w-2/3" />
            </div>
          </div>
        )}

        {/* Selection overlay */}
        {selectionMode && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all
                ${selected
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'bg-background/70 border-muted-foreground/40'
                }`}
            >
              {selected && <CheckCircle2 className="w-5 h-5" />}
            </div>
          </div>
        )}

        {/* Hover delete button (non-selection mode) */}
        {!selectionMode && onDeleteSingle && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteSingle(project.id);
            }}
            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-background/80 border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive hover:border-destructive hover:text-destructive-foreground"
            title="Delete short"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Info */}
      <div className="p-3">
        <p className="font-medium text-sm text-card-foreground truncate group-hover:text-primary transition-colors">
          {project.title ?? 'Untitled'}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {project.durationSeconds ? `${Math.round(project.durationSeconds)}s · ` : ''}
          {project.createdAt
            ? formatDistanceToNow(new Date(project.createdAt), { addSuffix: true })
            : ''}
        </p>
        <span
          className={`mt-2 inline-block px-2 py-0.5 text-xs rounded-full font-medium ${
            STATUS_STYLES[project.status ?? ''] ?? 'bg-muted text-muted-foreground'
          }`}
        >
          {project.status ?? 'Unknown'}
        </span>
      </div>
    </div>
  );
}
