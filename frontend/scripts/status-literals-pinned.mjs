// Design: the selectors the status-palette change moved from a colour literal onto a --sr-* token
// (derived from `git diff origin/main...HEAD` over src/styles and src/components: every rule whose
// colour literal was replaced by a token). Any chromatic colour literal in one of them fails
// check-status-literals whatever its hue, so a removed blue, cyan or amber cannot come back
// under a name with no state word. A selector matches by its text without the
// body.app-slava-restraint prefix.
export const PINNED_SELECTORS = {
  'components/brand/BrandShowcase.css': [
    ".nn-bs__chip--active",
  ],
  'components/editor/EditorView.css': [
    ".editor-tl__viewport",
    ".editor-tl__viewport::-webkit-scrollbar-thumb",
    ".editor-tl__viewport::-webkit-scrollbar-thumb:hover",
  ],
  'components/onboarding/onboarding.css': [
    ".onboarding__cta--primary",
    ".onboarding__cta--primary:hover",
    ".onboarding__spotlight",
  ],
  'components/projects/KeptDeleteChooser.css': [
    ".kept-delete-chooser__error",
  ],
  'components/projects/ProjectSizePanel.css': [
    ".project-size-panel__heading",
  ],
  'components/projects/ProjectWorkspaceControls.css': [
    ".project-workspace-controls__not-saved",
    ".project-workspace-controls__paused",
  ],
  'styles/agentCursor.css': [
    ".agent-cursor__error",
  ],
  'styles/asset-move.css': [
    ".asset-move__item:hover:not([aria-disabled=\"true\"])",
  ],
  'styles/asset-proposals.css': [
    ".asset-proposal__error",
  ],
  'styles/canvas.css': [
    ".selection-toolbar__button--primary",
    ".selection-toolbar__button--primary:hover:not(:disabled)",
  ],
  'styles/canvasPins.css': [
    ".canvas-pin-kept-more:focus-visible",
    ".canvas-pin-layer",
    ".canvas-pin-toast",
  ],
  'styles/canvasProposals.css': [
    ".proposal-bar__error",
    ".proposal-ghost__cost--paid",
  ],
  'styles/character-studio.css': [
    ".assets-panel__tab--active",
    ".character-def__error",
    ".character-palette__empty--error",
    ".character-rail__empty--error",
  ],
  'styles/cinema-studio.css': [
    ".cinema-shots-rail__badge--done",
    ".cinema-shots-rail__badge--running",
  ],
  'styles/commons-evaluation.css': [
    ".commons-unsaved",
    ".evaluation-workspace nav button[aria-current]",
  ],
  'styles/keyboard-shortcuts.css': [
    ".keyboard-shortcuts__close:focus-visible",
  ],
  'styles/mask-painter.css': [
    ".mask-painter__cancel",
    ".mask-painter__empty",
    ".mask-painter__hint",
    ".mask-painter__icon-btn",
    ".mask-painter__icon-btn:hover",
    ".mask-painter__overlay",
    ".mask-painter__paint-btn",
    ".mask-painter__paint-btn:hover",
    ".mask-painter__panel",
    ".mask-painter__save",
    ".mask-painter__size",
    ".mask-painter__status",
    ".mask-painter__thumb",
    ".mask-painter__title",
    ".mask-painter__tool",
    ".mask-painter__tool--active",
    ".mask-painter__tool:hover",
  ],
  'styles/messageBox.css': [
    ".agent-log__resize:focus-visible",
    ".message-box__badge",
    ".message-box__context-remove:focus-visible",
    ".message-box__field-row:has(.message-box__field:focus-visible)",
    ".message-box__fold:focus-visible",
    ".message-box__item[data-focus-target]:focus",
    ".message-box__menu-item:focus-visible",
    ".message-box__option:focus-visible",
    ".message-box__pill:focus-visible",
    ".message-box__recipient-chip:focus-visible",
    ".message-box__send:focus-visible",
    ".message-box__show:focus-visible",
  ],
  'styles/moodboard-node.css': [
    ".moodboard-node--selected",
  ],
  'styles/moodboard-studio.css': [
    ".moodboard-analysis__outdated",
    ".moodboard-brief__stale",
    ".moodboard-clash--conflict",
    ".moodboard-color__flag",
    ".moodboard-inline__error",
    ".moodboard-rail__empty--error",
    ".moodboard-rail__scope-tab--active",
    ".moodboard-tile__cover",
  ],
  'styles/nodes.css': [
    ".before-after__divider",
    ".before-after__handle",
    ".mesh-modal__download-error",
    ".model-node__source-stale",
  ],
  'styles/panels.css': [

  ],
  'styles/paper-source-node.css': [
    ".paper-source-node--selected",
    ".paper-source-node__history a",
    ".paper-source-node__note a",
  ],
  'styles/personal-agents.css': [
    ".permission-card",
    ".permission-card__actions button:focus-visible",
    ".permission-card__allow",
    ".permission-card__icon",
    ".personal-agents__fine a",
    ".personal-agents__status[data-status='ready']",
    ".personal-warning__actions button:focus-visible",
    ".personal-warning__error",
  ],
  'styles/prompt-dialog.css': [
    ".prompt-dialog__actions button:focus-visible",
    ".prompt-dialog__field input:focus-visible",
    ".prompt-dialog__field textarea:focus-visible",
  ],
  'styles/provider-switcher.css': [
    ".provider-switcher__dot",
  ],
  'styles/remotion-editor.css': [
    ".remotion-editor-toolbar__record--active",
  ],
  'styles/run-history.css': [
    ".run-history__batch-result a",
    ".run-history__dot--complete",
    ".run-history__dot--failed",
    ".run-history__paper-snapshot a",
    ".run-history__status--complete",
  ],
  'styles/settings.css': [
    ".settings-row__dot--ok",
    ".settings-sa__drop--ready",
  ],
  'styles/slava-restraint.css': [
    ".editor-tl__clip--edited",
    ".editor-tl__clip--selected",
    ".editor-tl__playhead",
    ".final-export__error",
  ],
  'styles/spatial-preview.css': [
    ".spatial-preview",
    ".spatial-preview--invalid",
    ".spatial-preview--invalid .spatial-preview__eyebrow",
    ".spatial-preview__asset",
    ".spatial-preview__asset small",
    ".spatial-preview__asset-overflow",
    ".spatial-preview__assets-label",
    ".spatial-preview__chip",
    ".spatial-preview__eyebrow",
    ".spatial-preview__metric dd",
    ".spatial-preview__metric dt",
  ],
  'styles/world-preview.css': [
    ".world-environment-viewer__fallback-copy",
    ".world-environment-viewer__interactive-canvas:focus-visible",
    ".world-environment-viewer__loading",
    ".world-environment-viewer__spinner",
    ".world-modal__button:focus-visible",
    ".world-modal__download-error",
    ".world-modal__failure p",
    ".world-modal__icon-button:focus-visible",
    ".world-modal__lazy-loading",
    ".world-modal__no-splat > div",
    ".world-modal__segmented button:focus-visible",
    ".world-modal__status",
    ".world-modal__status--error",
    ".world-modal__status--ready",
    ".world-preview:focus-visible",
  ],
};
