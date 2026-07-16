import type { DocPageContent } from '../docs-content'

// order 15.5 places this right after Keyframe Animation in the Creative Tools group.
const page = {
  order: 15.5,
  slug: 'animate',
  title: 'Animate Workspace',
  description: 'Apply motion presets, add live procedural motion, and bake it into keyframes.',
  category: 'Creative Tools',
  related: ['keyframes', 'properties', 'text-captions-subtitles', 'motion'],
  sections: [
    {
      title: 'Open the Animate workspace',
      blocks: [
        {
          kind: 'list',
          items: [
            'Switch to the **Animate** workspace from the tab next to Edit and Color in the toolbar.',
            'It replaces the normal layout with a small preview, a mini **animate timeline** for picking the clip to animate, and the keyframe graph beside a **Presets** panel.',
            'The animate timeline marks clips that already carry motion with an **Animated** badge; an empty project shows **No clips to animate**.',
          ],
        },
        {
          kind: 'note',
          tone: 'info',
          text: 'Animate has no keyboard shortcut — reach it from the tab. Switching workspaces only changes the layout, never your project.',
        },
      ],
    },
    {
      title: 'Apply a motion preset',
      blocks: [
        {
          kind: 'steps',
          items: [
            'Select a clip in the animate timeline.',
            'Pick a preset from **Entrance**, **Exit**, or **Emphasis** — for example Fade In, Slide In, Pop In, Zoom In, Pulse, or Shake.',
            'Refine the result in the keyframe graph; presets drop **editable keyframes**.',
          ],
        },
        {
          kind: 'note',
          tone: 'info',
          text: 'The **On apply** toggle chooses **Replace** (clear the target properties first — good for swapping an entrance) or **Add** (layer onto existing keyframes).',
        },
      ],
    },
    {
      title: 'Add continuous motion',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Continuous motion is **procedural** — it runs live and non-destructively, without creating keyframes, until you bake it.',
        },
        {
          kind: 'table',
          headers: ['Modulator', 'Moves'],
          rows: [
            ['Float drift', 'Position and rotation, gently'],
            ['Sway', 'Rotation, back and forth'],
            ['Breath pulse', 'Size and opacity (not suited to text)'],
            ['Spin', 'Continuous rotation'],
            ['Micro shake', 'Small seeded position and rotation jitter'],
          ],
        },
        {
          kind: 'list',
          items: [
            'Each tile shows an animated preview of the motion, so you can read the feel before applying it.',
            'Click a modulator tile to apply it with sensible defaults; a **Live** dot appears on active tiles.',
            'Open an applied tile to adjust **Intensity** (0–200%) and **Duration** (25–300%), or **Remove** it. Dragging a slider previews live and folds into a single undo.',
            'A modulator that would rescale the box (Breath pulse) is disabled for text clips, with a reason on hover.',
            'Applying to several clips staggers the phase per clip so they do not move in lockstep.',
          ],
        },
        {
          kind: 'note',
          tone: 'info',
          text: 'An **Applied** summary lists what the selected clip carries: a keyframed-count chip for baked or hand-set properties versus one chip per **live** modulator — so you can tell procedural motion from keyframes at a glance. Each chip has a remove control.',
        },
      ],
    },
    {
      title: 'Bake motion to keyframes',
      blocks: [
        {
          kind: 'list',
          items: [
            'Use **Bake to keyframes** to flatten procedural motion on the selected clips into editable keyframes.',
            'Baking samples the live modulators across the clip, removes the procedural source, and leaves plain keyframes you can reshape in the graph.',
            'The button is enabled whenever the selection carries a live modulator; it is disabled when there is nothing procedural to bake.',
          ],
        },
        {
          kind: 'note',
          tone: 'tip',
          text: 'Bake when you want to hand-tune the exact motion; leave it live (unbaked) when you just want an easy, adjustable feel.',
        },
      ],
    },
    {
      title: 'Save and reuse an animation',
      blocks: [
        {
          kind: 'steps',
          items: [
            'Select a clip that already has keyframes.',
            'Click **Save** in the Presets panel and name the animation.',
            'Apply it later from the **Animations** list to another clip.',
          ],
        },
        {
          kind: 'note',
          tone: 'warning',
          text: 'Saved animations are stored per project. A preset needs a matching clip type to apply, and keyframes that fall inside a transition region are dropped.',
        },
      ],
    },
  ],
} satisfies DocPageContent

export default page
