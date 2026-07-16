/** Lazily loaded timeline panels used by optional editor sidebar modes. */

export const importKeyframeGraphPanel = () =>
  import('@/features/timeline/components/keyframe-graph-panel')

export const importTranscriptEditorPanel = () =>
  import('@/features/timeline/components/transcript-editor/transcript-editor-panel')
