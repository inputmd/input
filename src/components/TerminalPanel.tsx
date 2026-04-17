import { WebContainerTerminalView, type WebContainerTerminalViewProps } from '../terminal/WebContainerTerminalView.tsx';
import { useDialogs } from './DialogProvider.tsx';

export type TerminalPanelProps = Omit<WebContainerTerminalViewProps, 'dialogs'>;

export function TerminalPanel(props: TerminalPanelProps) {
  const dialogs = useDialogs();
  return (
    <WebContainerTerminalView
      {...props}
      dialogs={{
        showAlert: dialogs.showAlert,
        showPrompt: dialogs.showPrompt,
      }}
    />
  );
}
