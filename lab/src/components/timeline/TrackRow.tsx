import React from 'react';

interface Props {
  label: string;
  totalWidth: number;
  labelWidth: number;
  height: number;
  onClick?: () => void;
  children?: React.ReactNode;
}

export default function TrackRow({ label, totalWidth, labelWidth, height, onClick, children }: Props) {
  return (
    <div className="flex border-b border-border/40" style={{ height }}>
      <div className="shrink-0 flex items-center justify-end pr-2 border-r border-border/30" style={{ width: labelWidth }}>
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div
        className="relative flex-1 bg-muted/5 hover:bg-muted/10 transition-colors"
        style={{ width: totalWidth }}
        onClick={onClick}
      >
        {children}
      </div>
    </div>
  );
}
