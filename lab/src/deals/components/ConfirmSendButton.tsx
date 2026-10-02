/**
 * Send email — a button Jake clicks in the Lab (manual sends are allowed;
 * automated processes only ever draft). Sending can't be undone, so it is a
 * two-click button: the first click arms it ("Click again to send" for 4 s),
 * the second sends.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Loader2, Send } from 'lucide-react';

interface Props {
  onSend: () => void | Promise<void>;
  busy?: boolean;
  disabled?: boolean;
  label?: string;
  armedLabel?: string;
  busyLabel?: string;
  iconSize?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** Extra style while armed (e.g. a stronger colour). */
  armedStyle?: CSSProperties;
  armedClassName?: string;
}

export default function ConfirmSendButton({
  onSend, busy = false, disabled = false, label = 'Send', armedLabel = 'Click again to send', busyLabel = 'Sending…',
  iconSize = 12, title, className, style, armedStyle, armedClassName,
}: Props) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { if (busy || disabled) setArmed(false); }, [busy, disabled]);

  const click = () => {
    if (busy || disabled) return;
    if (timer.current) clearTimeout(timer.current);
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    void onSend();
  };

  return (
    <button
      type="button"
      onClick={click}
      disabled={busy || disabled}
      title={title ?? 'Sends this email from the sponsor inbox — click twice to confirm'}
      className={`${className ?? ''} ${armed ? armedClassName ?? '' : ''}`}
      style={{ ...style, ...(armed ? armedStyle : null) }}
    >
      {busy ? <Loader2 size={iconSize} className="animate-spin" /> : <Send size={iconSize} />}
      {busy ? busyLabel : armed ? armedLabel : label}
    </button>
  );
}
