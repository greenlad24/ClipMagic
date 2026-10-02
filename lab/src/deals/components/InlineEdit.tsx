import { useState, useEffect, useRef } from 'react';

interface InlineEditProps {
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

export default function InlineEdit({ value, onSave, placeholder, className = '', inputClassName = '' }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setVal(value); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    if (val.trim() !== value) onSave(val.trim());
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setVal(value); setEditing(false); }
        }}
        className={`bg-transparent border-b border-primary/40 outline-none w-full ${inputClassName || className}`}
      />
    );
  }

  return (
    <span
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`cursor-text hover:opacity-75 transition-opacity ${className}`}
    >
      {value || <span className="text-muted-foreground/40 italic">{placeholder}</span>}
    </span>
  );
}
