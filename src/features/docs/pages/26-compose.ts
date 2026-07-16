import type { DocPageContent } from '../docs-content'

const page = {
  order: 15.75,
  slug: 'motion',
  title: 'Motion Workspace',
  description: 'Build layered 2D compositions using the familiar editor shell and media library.',
  category: 'Creative Tools',
  related: ['animate', 'keyframes', 'concepts'],
  sections: [
    {
      title: 'Motion and Animate solve different jobs',
      blocks: [
        {
          kind: 'list',
          items: [
            '**Animate** edits keyframes and motion presets for clips selected on a regular sequence.',
            '**Motion** keeps the media library, preview, and properties visible while swapping the lower dock to a layer timeline.',
            'Switching to Motion never converts or replaces the regular sequence timeline.',
          ],
        },
      ],
    },
    {
      title: 'Create and open a composition',
      blocks: [
        {
          kind: 'steps',
          items: [
            'Open **Motion** from the workspace switcher.',
            'Use **New composition** in the layer timeline, or open an existing composition from the media library.',
            'Drag video, audio, images, text, shapes, adjustment presets, or another composition from the media library into the layer timeline.',
          ],
        },
      ],
    },
    {
      title: 'Work with layers and properties',
      blocks: [
        {
          kind: 'list',
          items: [
            'Drag a layer span left or right to move it in time. If several layers are selected, they move together and the gesture creates one undo step.',
            'Drag the three-dot handle at the left of a layer or group to change its stacking order. Child layers stay inside their current group while reordering.',
            'Each layer has visibility, lock, solo, blend-mode, in/out, and ordering controls.',
            'Select two or more layers and choose **Group** to create a collapsible parent. Group visibility, lock, solo, and span dragging apply to its child layers; choose **Ungroup** to release them.',
            'Right-click a layer or group to rename, group or ungroup, duplicate, copy, paste, or delete it. Double-clicking its name also starts inline renaming.',
            'Expand a layer to reveal the classic dope-sheet property rows beneath the existing Motion layer header, including values, auto-key controls, navigation, and keyframe diamonds.',
            'Use the property filter above the layers to show every property or only animated properties.',
            'Click a property diamond to add or remove a keyframe at the shared playhead. One continuous playhead spans the ruler, layer bars, and expanded property lanes.',
            'Select two neighboring keyframes to expose the classic easing control, preset panel, and cubic-bezier editor for that segment.',
            'Click a property curve icon to swap its keyframe lane for an inline value curve. Click another property to switch curves, or click the active icon again to return to the dope sheet. The inline curve supports timing, easing, and Bézier-handle editing without opening a separate panel.',
          ],
        },
      ],
    },
    {
      title: 'Use a composition in a regular edit',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A 2D composition remains a reusable composition asset. Place it in a regular sequence to trim and arrange it like a clip. Open its internal layers in Motion, or select the composition clip in Animate to animate the whole result as one object.',
        },
        {
          kind: 'note',
          tone: 'info',
          text: 'Internal layer animation and whole-clip animation are independent. This lets a title animate internally while the finished title composition also moves or fades on the main edit.',
        },
      ],
    },
  ],
} satisfies DocPageContent

export default page
