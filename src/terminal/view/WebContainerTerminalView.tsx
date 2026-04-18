import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Power, Zap } from 'lucide-react';
import { blurOnClose } from '../../dom_utils.ts';
import {
  useWebContainerTerminalController,
  type WebContainerTerminalConfig,
  type WebContainerTerminalControllerDialogs,
} from '../core.ts';
import { TerminalPersistenceDialog } from './TerminalPersistenceDialog.tsx';

export interface WebContainerTerminalViewProps {
  className?: string;
  config: WebContainerTerminalConfig;
  dialogs?: Partial<WebContainerTerminalControllerDialogs> | null;
  visible: boolean;
  workspaceChangesPersisted?: boolean;
  workspaceChangesNotice?: string | null;
}

export function WebContainerTerminalView({
  className,
  config,
  dialogs,
  visible,
  workspaceChangesPersisted = true,
  workspaceChangesNotice = null,
}: WebContainerTerminalViewProps) {
  const controller = useWebContainerTerminalController({
    config,
    dialogs,
    visible,
    workspaceChangesNotice,
    workspaceChangesPersisted,
  });
  const showPersistedHomeTrustConfiguration =
    config.persistedHome !== false && (config.persistedHome?.canConfigure ?? false);

  return (
    <aside
      class={`terminal-panel${visible ? '' : ' terminal-panel--hidden'}${className ? ` ${className}` : ''}`}
      aria-label="Terminal"
      aria-hidden={visible ? undefined : 'true'}
    >
      {controller.error ? (
        <div class="terminal-panel__error">{controller.error}</div>
      ) : (
        <>
          <div class={`terminal-panel__stack${controller.splitOpen ? ' terminal-panel__stack--split' : ''}`}>
            {controller.workspaceNotice.visible && controller.workspaceNotice.message ? (
              <button
                type="button"
                class="terminal-panel__notice"
                onClick={controller.workspaceNotice.dismiss}
                aria-label="Hide terminal changes notice"
              >
                {controller.workspaceNotice.message}
              </button>
            ) : null}
            {controller.visiblePaneIds.map((paneId, index) => (
              <div
                key={paneId}
                class={`terminal-panel__pane${controller.activePaneId === paneId ? ' terminal-panel__pane--active' : ''}`}
                data-pane-position={index === 0 ? 'top' : 'bottom'}
                onPointerDown={() => {
                  controller.actions.selectPane(paneId);
                }}
              >
                <div
                  class="terminal-panel__surface"
                  ref={(node) => {
                    controller.actions.setPaneContainer(paneId, node);
                  }}
                />
                {controller.resetBannerPaneId === paneId && controller.resetBannerText ? (
                  <div class="terminal-panel__reset-banner" role="status" aria-live="polite">
                    {controller.resetBannerText}
                  </div>
                ) : null}
              </div>
            ))}
            {controller.persistedHomePromptState ? (
              <div
                class="terminal-panel__trust-prompt"
                role="dialog"
                aria-modal="false"
                aria-labelledby="terminal-trust-title"
                onClick={(event) => {
                  if (event.target !== event.currentTarget) return;
                  controller.actions.closePersistedHomePrompt();
                }}
              >
                <div class="terminal-panel__trust-prompt-card">
                  <h2 id="terminal-trust-title" class="terminal-panel__trust-prompt-title">
                    {controller.persistedHomePromptState.title}
                  </h2>
                  <p class="terminal-panel__trust-prompt-message">{controller.persistedHomePromptState.message}</p>
                  {controller.persistedHomePromptState.note ? (
                    <p class="terminal-panel__trust-prompt-note">{controller.persistedHomePromptState.note}</p>
                  ) : null}
                  <div class="terminal-panel__trust-prompt-actions">
                    <button
                      type="button"
                      onClick={() => {
                        controller.actions.settlePersistedHomePrompt(false);
                      }}
                    >
                      Keep credential sync off
                    </button>
                    <button
                      type="button"
                      class="button-warning"
                      onClick={() => {
                        controller.actions.settlePersistedHomePrompt(true);
                      }}
                    >
                      Trust this {controller.persistedHomePromptState.target}, enable credential sync
                    </button>
                  </div>
                  <p class="terminal-panel__trust-prompt-note">This will restart running terminals.</p>
                </div>
              </div>
            ) : null}
          </div>
          <div class="terminal-panel__overlay-controls">
            <DropdownMenu.Root onOpenChange={blurOnClose}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  class="terminal-panel__credential-sync-trigger"
                  aria-label={`${controller.status.credentialSyncLabel}. ${controller.status.networkingLabel}. Terminal session settings`}
                  title={`${controller.status.credentialSyncLabel}. ${controller.status.networkingLabel}. Terminal session settings`}
                >
                  <Zap size={14} aria-hidden="true" />
                  <span>{controller.status.credentialSyncLabel}</span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="terminal-panel__menu" side="top" align="end" sideOffset={8}>
                  <DropdownMenu.Label class="terminal-panel__menu-note">
                    {controller.status.credentialSyncMenuNote}
                  </DropdownMenu.Label>
                  <DropdownMenu.Separator class="terminal-panel__menu-separator" />
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    onSelect={() => {
                      void controller.actions.openPersistenceDialog();
                    }}
                  >
                    View synced data
                  </DropdownMenu.Item>
                  {showPersistedHomeTrustConfiguration ? (
                    <DropdownMenu.Item
                      class="terminal-panel__menu-item"
                      onSelect={controller.actions.openPersistedHomeReconfigurePrompt}
                    >
                      Configure credential sync
                    </DropdownMenu.Item>
                  ) : null}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <DropdownMenu.Root onOpenChange={blurOnClose}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  class="terminal-panel__menu-trigger"
                  aria-label="Terminal actions"
                  title="Terminal actions"
                >
                  <Power size={14} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="terminal-panel__menu" side="top" align="end" sideOffset={8}>
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    disabled={!controller.canDownloadFromWebContainer}
                    onSelect={() => {
                      void controller.actions.downloadFromWebContainer();
                    }}
                  >
                    Download files...
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator class="terminal-panel__menu-separator" />
                  {!controller.splitOpen ? (
                    <DropdownMenu.Item
                      class="terminal-panel__menu-item"
                      disabled={!controller.canManageSplit}
                      onSelect={controller.actions.openSplitTerminal}
                    >
                      Split terminal
                    </DropdownMenu.Item>
                  ) : (
                    <>
                      <DropdownMenu.Item
                        class="terminal-panel__menu-item"
                        disabled={!controller.canManageSplit}
                        onSelect={() => {
                          controller.actions.closeSplitPane('top');
                        }}
                      >
                        Close top terminal
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="terminal-panel__menu-item"
                        disabled={!controller.canManageSplit}
                        onSelect={() => {
                          controller.actions.closeSplitPane('bottom');
                        }}
                      >
                        Close bottom terminal
                      </DropdownMenu.Item>
                    </>
                  )}
                  <DropdownMenu.Separator class="terminal-panel__menu-separator" />
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    disabled={!controller.canResetTerminal}
                    onSelect={() => {
                      void controller.actions.restartShell();
                    }}
                  >
                    Reset terminal
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    disabled={!controller.canRestartWebContainer}
                    onSelect={() => {
                      void controller.actions.restartWebContainer();
                    }}
                  >
                    Restart WebContainer
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          <TerminalPersistenceDialog
            open={controller.persistenceDialog.open}
            loading={controller.persistenceDialog.loading}
            error={controller.persistenceDialog.error}
            snapshot={controller.persistenceDialog.snapshot}
            onClose={controller.actions.closePersistenceDialog}
          />
        </>
      )}
    </aside>
  );
}
