import type { ComponentChildren } from 'preact';

interface ContentAlertProps {
  children: ComponentChildren;
  className?: string;
}

export function ContentAlert({ children, className }: ContentAlertProps) {
  return (
    <div class={`content-alert ${className ?? ''}`.trim()} role="status">
      {children}
    </div>
  );
}
