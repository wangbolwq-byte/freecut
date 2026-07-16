# editor/deps

Editor-local adapters for external feature dependencies.

- `timeline-*-contract.ts`: focused editor->timeline seams. Keep store, hook,
  utility, Motion, and optional-panel edges separate so importing one adapter
  does not eagerly load the entire timeline feature in development.
- `timeline-contract.ts`: legacy compatibility seam. Avoid it in startup-path
  code; prefer the focused adapters below.
- `timeline-store.ts`: timeline store selectors and timeline state/action types.
- `timeline-ui.ts`: classic timeline and dialog lazy-load helpers plus dialog
  stores.
- `timeline-hooks.ts`: timeline feature hooks used by editor shell.
- `timeline-utils.ts`: timeline utility functions used by editor components.
- `timeline-cache.ts`: lazy import helpers for timeline cache services.
- `timeline-subscriptions.ts`: transition-chain subscription bootstrap.
- `timeline-motion.ts`: Motion workspace stores, actions, and dopesheet UI.
- `timeline-panels.ts`: lazy import helpers for optional graph/transcript panels.
- `timeline.ts`: compatibility barrel that re-exports the timeline adapters
  above. Prefer importing the more specific module directly in new code.
- `media-library.ts`: the preferred entry point for editor modules that need
  media-library stores, components, or media-related services/utilities.
- `preview.ts`: the preferred entry point for editor modules that need
  preview components, preview stores, or preview hooks.
- `project-bundle.ts`: the preferred entry point for editor modules that need
  project-bundle dialogs and import/export/test fixture services.
- `keyframes.ts`: the preferred entry point for editor modules that need
  keyframes components and animation/keyframe utility functions.
- `projects.ts`: the preferred entry point for editor modules that need
  project metadata/state stores.
- `settings.ts`: the preferred entry point for editor modules that need
  editor settings/preferences stores.
- `effects-contract.ts`: adapter exports for editor modules that need
  effects feature components.
- `export-contract.ts`: adapter exports for editor modules that need
  export feature dialogs/helpers.
- `composition-runtime.ts`: the preferred entry point for editor modules that
  need transform/audio-cache helpers from composition runtime.
