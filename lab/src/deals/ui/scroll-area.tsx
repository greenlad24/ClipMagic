/**
 * Stand-in for the Radix ScrollArea (@radix-ui/react-scroll-area is not
 * installed in the Lab): a native overflow container with the same outer
 * class names. Scrollbars are the browser's own, thinned via CSS.
 */
import * as React from 'react';
import { cn } from './utils';

const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={cn('relative overflow-hidden', className)} {...props}>
      <div className="dealorg-scroll h-full w-full overflow-y-auto overflow-x-hidden rounded-[inherit]">{children}</div>
    </div>
  ),
);
ScrollArea.displayName = 'ScrollArea';

export { ScrollArea };
