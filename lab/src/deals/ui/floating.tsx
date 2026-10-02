/**
 * Deal Organizer — small replacements for the Radix Popover, Tooltip and
 * DropdownMenu primitives the original app used (@radix-ui/react-popover,
 * -tooltip and -dropdown-menu are not installed in the Lab). Same component
 * names, same props the app passes, same shadcn class names.
 *
 * Content is portalled to <body> and placed with `position: fixed` next to the
 * trigger (side/align/sideOffset), flipping when it would leave the viewport.
 * Closes on outside press and Escape. `asChild` triggers use @radix-ui/react-slot
 * (installed), which merges handlers and refs the way Radix does.
 */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Slot } from '@radix-ui/react-slot';

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';

/** Fixed-position coordinates for `content` next to `anchor`. */
export function useFloatingPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  side: Side = 'bottom',
  align: Align = 'center',
  offset = 4,
): CSSProperties {
  const [pos, setPos] = useState<CSSProperties>({ position: 'fixed', top: -9999, left: -9999 });

  const update = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const c = content.current;
    if (!a || !c) return;
    const cw = c.offsetWidth;
    const ch = c.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let s = side;
    if (s === 'bottom' && a.bottom + offset + ch > vh && a.top - offset - ch > 0) s = 'top';
    else if (s === 'top' && a.top - offset - ch < 0 && a.bottom + offset + ch < vh) s = 'bottom';
    else if (s === 'right' && a.right + offset + cw > vw && a.left - offset - cw > 0) s = 'left';
    else if (s === 'left' && a.left - offset - cw < 0) s = 'right';
    let top = 0;
    let left = 0;
    if (s === 'bottom' || s === 'top') {
      top = s === 'bottom' ? a.bottom + offset : a.top - offset - ch;
      left = align === 'start' ? a.left : align === 'end' ? a.right - cw : a.left + a.width / 2 - cw / 2;
    } else {
      left = s === 'right' ? a.right + offset : a.left - offset - cw;
      top = align === 'start' ? a.top : align === 'end' ? a.bottom - ch : a.top + a.height / 2 - ch / 2;
    }
    left = Math.max(8, Math.min(left, vw - cw - 8));
    top = Math.max(8, Math.min(top, vh - ch - 8));
    setPos({ position: 'fixed', top, left });
  }, [anchor, content, side, align, offset]);

  useLayoutEffect(() => {
    if (!open) return;
    update();
    const raf = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, update]);

  return pos;
}

/** Close on a press outside every element in `refs`, and on Escape. */
function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], onDismiss: () => void) {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      // A press inside another floating layer (e.g. a submenu) is not "outside".
      if ((t as HTMLElement).closest?.('[data-dm-floating]')) return;
      cb.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cb.current(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

function useControllable(open: boolean | undefined, onOpenChange: ((o: boolean) => void) | undefined, initial = false) {
  const [inner, setInner] = useState(initial);
  const isControlled = open !== undefined;
  const value = isControlled ? open : inner;
  const set = useCallback((o: boolean) => {
    if (!isControlled) setInner(o);
    onOpenChange?.(o);
  }, [isControlled, onOpenChange]);
  return [value, set] as const;
}

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ── Popover ─────────────────────────────────────────────────────────────────
type PopCtx = { open: boolean; setOpen: (o: boolean) => void; trigger: RefObject<HTMLElement | null> };
const PopoverCtx = createContext<PopCtx | null>(null);

export function Popover({ open, onOpenChange, defaultOpen, children }: {
  open?: boolean; onOpenChange?: (o: boolean) => void; defaultOpen?: boolean; children?: ReactNode;
}) {
  const [value, set] = useControllable(open, onOpenChange, defaultOpen);
  const trigger = useRef<HTMLElement | null>(null);
  return <PopoverCtx.Provider value={{ open: value, setOpen: set, trigger }}>{children}</PopoverCtx.Provider>;
}

export function PopoverTrigger({ asChild, children, ...rest }: { asChild?: boolean; children?: ReactNode; [k: string]: any }) {
  const ctx = useContext(PopoverCtx)!;
  const Comp: any = asChild ? Slot : 'button';
  return (
    <Comp ref={ctx.trigger} data-state={ctx.open ? 'open' : 'closed'} {...rest} onClick={() => ctx.setOpen(!ctx.open)}>
      {children}
    </Comp>
  );
}

export function PopoverContent({ side = 'bottom', align = 'center', sideOffset = 4, className, style, children, ...rest }: {
  side?: Side; align?: Align; sideOffset?: number; className?: string; style?: CSSProperties; children?: ReactNode; [k: string]: any;
}) {
  const ctx = useContext(PopoverCtx)!;
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFloatingPosition(ctx.open, ctx.trigger, ref, side, align, sideOffset);
  useDismiss(ctx.open, [ref, ctx.trigger], () => ctx.setOpen(false));
  if (!ctx.open) return null;
  return createPortal(
    <div
      ref={ref}
      data-dm-floating=""
      data-state="open"
      data-side={side}
      className={cx('z-[100] w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none animate-in fade-in-0 zoom-in-95', className)}
      style={{ ...style, ...pos }}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}

// ── Tooltip ─────────────────────────────────────────────────────────────────
type TipCtx = { open: boolean; setOpen: (o: boolean) => void; trigger: RefObject<HTMLElement | null>; delay: number };
const TooltipCtx = createContext<TipCtx | null>(null);
const DelayCtx = createContext(700);

export function TooltipProvider({ delayDuration = 700, children }: { delayDuration?: number; children?: ReactNode; [k: string]: any }) {
  return <DelayCtx.Provider value={delayDuration}>{children}</DelayCtx.Provider>;
}

export function Tooltip({ children, delayDuration }: { children?: ReactNode; delayDuration?: number; [k: string]: any }) {
  const inherited = useContext(DelayCtx);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  return <TooltipCtx.Provider value={{ open, setOpen, trigger, delay: delayDuration ?? inherited }}>{children}</TooltipCtx.Provider>;
}

export function TooltipTrigger({ asChild, children, ...rest }: { asChild?: boolean; children?: ReactNode; [k: string]: any }) {
  const ctx = useContext(TooltipCtx)!;
  const timer = useRef<number>();
  const show = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => ctx.setOpen(true), ctx.delay); };
  const hide = () => { window.clearTimeout(timer.current); ctx.setOpen(false); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const Comp: any = asChild ? Slot : 'button';
  return (
    <Comp ref={ctx.trigger} {...rest} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onPointerDown={hide}>
      {children}
    </Comp>
  );
}

export function TooltipContent({ side = 'top', align = 'center', sideOffset = 4, className, children }: {
  side?: Side; align?: Align; sideOffset?: number; className?: string; children?: ReactNode; [k: string]: any;
}) {
  const ctx = useContext(TooltipCtx)!;
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFloatingPosition(ctx.open, ctx.trigger, ref, side, align, sideOffset);
  if (!ctx.open) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-dm-floating=""
      className={cx('pointer-events-none z-[110] overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95', className)}
      style={pos}
    >
      {children}
    </div>,
    document.body,
  );
}

// ── DropdownMenu ────────────────────────────────────────────────────────────
type MenuCtx = { open: boolean; setOpen: (o: boolean) => void; trigger: RefObject<HTMLElement | null> };
const DropdownCtx = createContext<MenuCtx | null>(null);

export function DropdownMenu({ open, onOpenChange, defaultOpen, children }: {
  open?: boolean; onOpenChange?: (o: boolean) => void; defaultOpen?: boolean; children?: ReactNode; [k: string]: any;
}) {
  const [value, set] = useControllable(open, onOpenChange, defaultOpen);
  const trigger = useRef<HTMLElement | null>(null);
  return <DropdownCtx.Provider value={{ open: value, setOpen: set, trigger }}>{children}</DropdownCtx.Provider>;
}

export function DropdownMenuTrigger({ asChild, children, ...rest }: { asChild?: boolean; children?: ReactNode; [k: string]: any }) {
  const ctx = useContext(DropdownCtx)!;
  const Comp: any = asChild ? Slot : 'button';
  return (
    <Comp ref={ctx.trigger} aria-haspopup="menu" aria-expanded={ctx.open} data-state={ctx.open ? 'open' : 'closed'} {...rest} onClick={() => ctx.setOpen(!ctx.open)}>
      {children}
    </Comp>
  );
}

export function DropdownMenuContent({ side = 'bottom', align = 'center', sideOffset = 4, className, style, children, ...rest }: {
  side?: Side; align?: Align; sideOffset?: number; className?: string; style?: CSSProperties; children?: ReactNode; [k: string]: any;
}) {
  const ctx = useContext(DropdownCtx)!;
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFloatingPosition(ctx.open, ctx.trigger, ref, side, align, sideOffset);
  useDismiss(ctx.open, [ref, ctx.trigger], () => ctx.setOpen(false));
  if (!ctx.open) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-dm-floating=""
      className={cx('z-[100] min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95', className)}
      style={{ ...style, ...pos }}
      onClick={(e) => e.stopPropagation()}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}

export function DropdownMenuItem({ className, onClick, onSelect, disabled, inset, children, ...rest }: {
  className?: string; onClick?: (e: React.MouseEvent) => void; onSelect?: (e: Event) => void;
  disabled?: boolean; inset?: boolean; children?: ReactNode; [k: string]: any;
}) {
  const ctx = useContext(DropdownCtx);
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      data-disabled={disabled ? '' : undefined}
      className={cx(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0',
        inset && 'pl-8',
        className,
      )}
      onClick={(e) => {
        if (disabled) return;
        onClick?.(e);
        onSelect?.(e.nativeEvent);
        ctx?.setOpen(false);
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cx('-mx-1 my-1 h-px bg-muted', className)} />;
}

export function DropdownMenuLabel({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cx('px-2 py-1.5 text-sm font-semibold', className)}>{children}</div>;
}

type SubCtxT = { open: boolean; setOpen: (o: boolean) => void; trigger: RefObject<HTMLElement | null>; cancelClose: () => void; scheduleClose: () => void };
const SubCtx = createContext<SubCtxT | null>(null);

export function DropdownMenuSub({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const timer = useRef<number>();
  const cancelClose = () => window.clearTimeout(timer.current);
  const scheduleClose = () => { cancelClose(); timer.current = window.setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <SubCtx.Provider value={{ open, setOpen, trigger, cancelClose, scheduleClose }}>{children}</SubCtx.Provider>;
}

export function DropdownMenuSubTrigger({ className, inset, children }: { className?: string; inset?: boolean; children?: ReactNode }) {
  const sub = useContext(SubCtx)!;
  return (
    <div
      ref={sub.trigger as RefObject<HTMLDivElement>}
      role="menuitem"
      data-state={sub.open ? 'open' : 'closed'}
      className={cx(
        'flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        inset && 'pl-8',
        className,
      )}
      onMouseEnter={() => { sub.cancelClose(); sub.setOpen(true); }}
      onMouseLeave={sub.scheduleClose}
      onClick={() => sub.setOpen(!sub.open)}
    >
      {children}
      <svg className="ml-auto" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
    </div>
  );
}

export function DropdownMenuSubContent({ className, children }: { className?: string; children?: ReactNode }) {
  const sub = useContext(SubCtx)!;
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFloatingPosition(sub.open, sub.trigger, ref, 'right', 'start', 2);
  if (!sub.open) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-dm-floating=""
      className={cx('z-[105] min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95', className)}
      style={pos}
      onMouseEnter={sub.cancelClose}
      onMouseLeave={sub.scheduleClose}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
