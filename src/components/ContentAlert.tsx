import type { ComponentChildren } from 'preact';

interface ContentAlertProps {
  children: ComponentChildren;
}

export function ContentAlert({ children }: ContentAlertProps) {
  return (
    <div class="content-alert" role="status">
      {children}
    </div>
  );
}
