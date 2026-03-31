import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { formatReaderAiModelDisplayName, type ReaderAiModel, readerAiModelPriorityRank } from '../reader_ai';

interface ReaderAiModelSelectorProps {
  models: ReaderAiModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  localCodexEnabled?: boolean;
  onEnableLocalCodex?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  menuClassName?: string;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  showFreeBadge?: boolean;
  showLoginForMoreModels?: boolean;
}

function displayModelName(model: ReaderAiModel): string {
  return formatReaderAiModelDisplayName(model);
}

export function selectedReaderAiModelLabel(
  models: ReaderAiModel[],
  selectedModel: string,
  modelsLoading: boolean,
): string {
  const model = models.find((entry) => entry.id === selectedModel);
  if (model) return displayModelName(model);
  if (modelsLoading) return 'Loading models...';
  return 'No models';
}

function selectedReaderAiModel(models: ReaderAiModel[], selectedModel: string): ReaderAiModel | null {
  return models.find((entry) => entry.id === selectedModel) ?? null;
}

export function ReaderAiModelSelector({
  models,
  modelsLoading,
  modelsError,
  selectedModel,
  onSelectModel,
  localCodexEnabled = false,
  onEnableLocalCodex,
  open,
  onOpenChange,
  disabled = false,
  triggerClassName = 'reader-ai-model-trigger',
  triggerAriaLabel = 'Reader AI model',
  menuClassName = 'reader-ai-model-menu',
  align = 'start',
  sideOffset = 6,
  showFreeBadge = false,
  showLoginForMoreModels = false,
}: ReaderAiModelSelectorProps) {
  const preventTriggerFocusRestore = (event: Event) => {
    event.preventDefault();
  };
  const localModels = models.filter((model) => model.provider === 'codex_local');
  const paidModels = models.filter(
    (model) => model.provider !== 'codex_local' && !model.id.trim().toLowerCase().endsWith(':free'),
  );
  const displayedPaidModels = [...paidModels].reverse();
  const freeModels = models.filter(
    (model) => model.provider !== 'codex_local' && model.id.trim().toLowerCase().endsWith(':free'),
  );
  const featuredModels = freeModels.filter((model) => readerAiModelPriorityRank(model) !== -1);
  const unverifiedModels = freeModels.filter((model) => readerAiModelPriorityRank(model) === -1);
  const hasRecommendedSection = localModels.length > 0 || paidModels.length > 0 || featuredModels.length > 0;
  const canOptIntoLocalCodex = !localCodexEnabled && Boolean(onEnableLocalCodex);
  const shouldShowLocalCodexSection = localCodexEnabled || localModels.length > 0;
  const canOpenMenuWithoutModels = canOptIntoLocalCodex || shouldShowLocalCodexSection;
  const modelSelectDisabled = disabled || modelsLoading || (models.length === 0 && !canOpenMenuWithoutModels);
  const selectedModelEntry = selectedReaderAiModel(models, selectedModel);
  const shouldShowFreeBadge =
    showFreeBadge &&
    Boolean(
      selectedModelEntry &&
        selectedModelEntry.provider !== 'codex_local' &&
        selectedModelEntry.id.trim().toLowerCase().endsWith(':free'),
    );
  const modelTriggerLabel = selectedReaderAiModelLabel(models, selectedModel, modelsLoading);
  const showLoggedOutHeading =
    showLoginForMoreModels && paidModels.length === 0 && (featuredModels.length > 0 || unverifiedModels.length > 0);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        onOpenChange?.(nextOpen);
        if (!nextOpen) (document.activeElement as HTMLElement | null)?.blur?.();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          class={triggerClassName}
          aria-label={triggerAriaLabel}
          title={modelTriggerLabel}
          disabled={modelSelectDisabled}
        >
          <span class="reader-ai-model-trigger-content">
            {shouldShowFreeBadge ? <span class="reader-ai-model-trigger-badge toolbar-desktop-only">Free</span> : null}
            <span class="reader-ai-model-trigger-label">{modelTriggerLabel}</span>
          </span>
          <ChevronDown size={14} class="reader-ai-model-trigger-icon" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class={menuClassName}
          sideOffset={sideOffset}
          align={align}
          onCloseAutoFocus={preventTriggerFocusRestore}
        >
          {models.length > 0 ? (
            <DropdownMenu.RadioGroup value={selectedModel} onValueChange={onSelectModel}>
              {paidModels.length > 0 ? (
                <>
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Recommended models
                  </DropdownMenu.Item>
                  {displayedPaidModels.map((model) => (
                    <DropdownMenu.RadioItem key={model.id} class="reader-ai-model-menu-item" value={model.id}>
                      {displayModelName(model)}
                    </DropdownMenu.RadioItem>
                  ))}
                </>
              ) : null}

              {showLoggedOutHeading ? (
                <>
                  {paidModels.length > 0 || localModels.length > 0 ? (
                    <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                  ) : null}
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Log in for more models
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                </>
              ) : null}

              {featuredModels.length > 0 ? (
                <>
                  {paidModels.length > 0 || localModels.length > 0 ? (
                    <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                  ) : null}
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Recommended free models
                  </DropdownMenu.Item>
                  {featuredModels.map((model) => (
                    <DropdownMenu.RadioItem key={model.id} class="reader-ai-model-menu-item" value={model.id}>
                      {displayModelName(model)}
                    </DropdownMenu.RadioItem>
                  ))}
                </>
              ) : null}

              {shouldShowLocalCodexSection ? (
                <>
                  {paidModels.length > 0 || featuredModels.length > 0 ? (
                    <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                  ) : null}
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Via local Codex server
                  </DropdownMenu.Item>
                  {localModels.length > 0 ? (
                    localModels.map((model) => (
                      <DropdownMenu.RadioItem key={model.id} class="reader-ai-model-menu-item" value={model.id}>
                        {displayModelName(model)}
                      </DropdownMenu.RadioItem>
                    ))
                  ) : (
                    <DropdownMenu.Item
                      class="reader-ai-model-menu-item reader-ai-model-menu-item--unavailable"
                      disabled
                    >
                      Codex app-server not found
                    </DropdownMenu.Item>
                  )}
                </>
              ) : null}

              {!localCodexEnabled && onEnableLocalCodex ? (
                <>
                  {paidModels.length > 0 || featuredModels.length > 0 || localModels.length > 0 ? (
                    <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                  ) : null}
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Local Codex
                  </DropdownMenu.Item>
                  <DropdownMenu.Item class="reader-ai-model-menu-item" onSelect={onEnableLocalCodex}>
                    Enable local Codex models
                  </DropdownMenu.Item>
                </>
              ) : null}

              {unverifiedModels.length > 0 ? (
                <>
                  {hasRecommendedSection ? <DropdownMenu.Separator class="reader-ai-model-menu-separator" /> : null}
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Unverified free models
                  </DropdownMenu.Item>
                  {unverifiedModels.map((model) => (
                    <DropdownMenu.RadioItem key={model.id} class="reader-ai-model-menu-item" value={model.id}>
                      {displayModelName(model)}
                    </DropdownMenu.RadioItem>
                  ))}
                </>
              ) : null}
            </DropdownMenu.RadioGroup>
          ) : (
            <>
              <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                {modelsError ?? (modelsLoading ? 'Loading free models...' : 'No free model available.')}
              </DropdownMenu.Item>
              {shouldShowLocalCodexSection ? (
                <>
                  <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Via local Codex server
                  </DropdownMenu.Item>
                  <DropdownMenu.Item class="reader-ai-model-menu-item reader-ai-model-menu-item--unavailable" disabled>
                    Codex app-server not found
                  </DropdownMenu.Item>
                </>
              ) : null}
              {canOptIntoLocalCodex ? (
                <>
                  <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                  <DropdownMenu.Item class="reader-ai-model-menu-item" onSelect={onEnableLocalCodex}>
                    Enable local Codex models
                  </DropdownMenu.Item>
                </>
              ) : null}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
