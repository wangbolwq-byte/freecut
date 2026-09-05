import test from 'node:test'
import assert from 'node:assert/strict'
import { auditRemixProject } from './lib/project-audit.mjs'

function createProject(items) {
  return {
    id: 'remix-project',
    timeline: {
      tracks: [
        { id: 'video-track', kind: 'video' },
        { id: 'audio-track', kind: 'audio' },
      ],
      items,
    },
  }
}

test('remix audit accepts a continuous 12-clip timeline spanning one source', () => {
  const items = Array.from({ length: 12 }, (_, index) => {
    const sourceStart = index * 300
    const linkedGroupId = `linked-${index}`
    const common = {
      from: index * 150,
      durationInFrames: 150,
      mediaId: 'video-media',
      sourceStart,
      sourceEnd: sourceStart + 150,
      sourceDuration: 3600,
      linkedGroupId,
    }
    return [
      { ...common, id: `video-${index}`, type: 'video', trackId: 'video-track' },
      { ...common, id: `audio-${index}`, type: 'audio', trackId: 'audio-track' },
    ]
  }).flat()

  const result = auditRemixProject(createProject(items))
  assert.equal(result.ok, true)
  assert.equal(result.metrics.duplicateRangeCount, 0)
  assert.ok(items.some((item) => item.type === 'video' && item.sourceStart >= 1440))
})

test('remix audit rejects repeated source beginnings, timeline gaps, and AV mismatches', () => {
  const project = createProject([
    {
      id: 'video-1',
      type: 'video',
      trackId: 'video-track',
      from: 0,
      durationInFrames: 90,
      mediaId: 'video-media',
      sourceStart: 0,
      sourceEnd: 90,
      sourceDuration: 900,
      linkedGroupId: 'linked-1',
    },
    {
      id: 'audio-1',
      type: 'audio',
      trackId: 'audio-track',
      from: 0,
      durationInFrames: 90,
      mediaId: 'video-media',
      sourceStart: 10,
      sourceEnd: 100,
      sourceDuration: 900,
      linkedGroupId: 'linked-1',
    },
    ...[1, 2].map((index) => ({
      id: `video-${index + 1}`,
      type: 'video',
      trackId: 'video-track',
      from: 100 + index * 90,
      durationInFrames: 90,
      mediaId: 'video-media',
      sourceStart: 0,
      sourceEnd: 90,
      sourceDuration: 900,
    })),
  ])

  const result = auditRemixProject(project)
  assert.equal(result.ok, false)
  const codes = new Set(result.issues.map((issue) => issue.code))
  assert.ok(codes.has('timeline_gap'))
  assert.ok(codes.has('av_source_range_mismatch'))
  assert.ok(codes.has('source_range_overlap'))
  assert.ok(codes.has('source_beginning_reused'))
  assert.ok(codes.has('source_ranges_front_loaded'))
})

test('remix audit rejects source ranges that move backward along the timeline', () => {
  const result = auditRemixProject(
    createProject([
      {
        id: 'video-later-source',
        type: 'video',
        trackId: 'video-track',
        from: 0,
        durationInFrames: 90,
        mediaId: 'video-media',
        sourceStart: 300,
        sourceEnd: 390,
        sourceDuration: 900,
      },
      {
        id: 'video-earlier-source',
        type: 'video',
        trackId: 'video-track',
        from: 90,
        durationInFrames: 90,
        mediaId: 'video-media',
        sourceStart: 0,
        sourceEnd: 90,
        sourceDuration: 900,
      },
    ]),
  )

  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.code === 'source_range_not_monotonic'))
})

test('remix audit permits intentional gaps on sparse visual roles only', () => {
  const project = {
    id: 'track-role-project',
    timeline: {
      tracks: [
        { id: 'primary', kind: 'video', role: 'primary-visual' },
        { id: 'overlay', kind: 'video', role: 'overlay' },
      ],
      items: [
        { id: 'primary-a', type: 'image', trackId: 'primary', from: 0, durationInFrames: 30 },
        { id: 'primary-b', type: 'image', trackId: 'primary', from: 60, durationInFrames: 30 },
        { id: 'overlay-a', type: 'image', trackId: 'overlay', from: 0, durationInFrames: 10 },
        { id: 'overlay-b', type: 'image', trackId: 'overlay', from: 80, durationInFrames: 10 },
      ],
    },
  }

  const gaps = auditRemixProject(project).issues.filter((issue) => issue.code === 'timeline_gap')
  assert.deepEqual(
    gaps.map((issue) => issue.trackIds),
    [['primary']],
  )
})

test('remix audit reports motion, transition, audio, music, and GPU coverage as facts', () => {
  const project = {
    id: 'semantic-project',
    timeline: {
      masterBusDb: 0,
      tracks: [
        { id: 'video-track', kind: 'video' },
        { id: 'source-audio', kind: 'audio', name: 'Original', muted: true, volume: 0 },
        { id: 'music-track', kind: 'audio', name: 'Music', muted: false, volume: -8 },
        { id: 'overlay-track', kind: 'video' },
      ],
      items: [
        {
          id: 'video-a',
          type: 'video',
          trackId: 'video-track',
          from: 0,
          durationInFrames: 90,
          mediaId: 'media-a',
          sourceStart: 30,
          sourceEnd: 120,
          sourceDuration: 600,
          effects: [{ id: 'blur', enabled: true, effect: { gpuEffectType: 'gpu-gaussian-blur' } }],
        },
        {
          id: 'video-b',
          type: 'video',
          trackId: 'video-track',
          from: 90,
          durationInFrames: 90,
          mediaId: 'media-b',
          sourceStart: 30,
          sourceEnd: 120,
          sourceDuration: 600,
        },
        {
          id: 'sticker',
          type: 'image',
          trackId: 'overlay-track',
          from: 0,
          durationInFrames: 180,
        },
        {
          id: 'original-audio',
          type: 'audio',
          trackId: 'source-audio',
          from: 0,
          durationInFrames: 180,
          linkedGroupId: 'linked-original',
        },
        {
          id: 'music',
          type: 'audio',
          trackId: 'music-track',
          from: 0,
          durationInFrames: 120,
        },
      ],
      transitions: [
        {
          id: 'transition-a-b',
          type: 'crossfade',
          presentation: 'slide',
          direction: 'from-left',
          leftClipId: 'video-a',
          rightClipId: 'video-b',
          durationInFrames: 15,
          alignment: 0.5,
        },
      ],
      keyframes: [
        {
          itemId: 'sticker',
          properties: [
            {
              property: 'x',
              keyframes: [
                { id: 'x-start', frame: 0, value: -300, easing: 'linear' },
                { id: 'x-end', frame: 179, value: 300, easing: 'linear' },
              ],
            },
          ],
        },
      ],
    },
  }

  const facts = auditRemixProject(project).semanticFacts
  assert.equal(facts.overlayPositions[0].positionAnimation.hasActualMotion, true)
  assert.equal(facts.overlayPositions[0].positionAnimation.displacement, 600)
  assert.deepEqual(facts.transitions[0].coverage, { from: 82, to: 97 })
  assert.equal(facts.uncoveredCuts.length, 0)
  assert.deepEqual(
    facts.audio.tracks.map(({ trackId, muted, volumeDb }) => ({ trackId, muted, volumeDb })),
    [
      { trackId: 'source-audio', muted: true, volumeDb: 0 },
      { trackId: 'music-track', muted: false, volumeDb: -8 },
    ],
  )
  assert.equal(facts.audio.zeroDbMeaning, 'unity_gain')
  assert.equal(facts.audio.unlinkedAudioCoverage.frames, 120)
  assert.equal(facts.audio.roleClassification, 'unknown_without_explicit_production_manifest')
  assert.equal(facts.audio.backgroundMusicCoverage, undefined)
  assert.deepEqual(facts.gpuEffects[0].coverage, { from: 0, to: 90 })
  assert.equal(
    facts.findings.some((finding) => finding.code === 'background_music_undercoverage'),
    false,
  )
  assert.equal(
    facts.findings.some((finding) => finding.code === 'static_overlay_position'),
    false,
  )
})

test('source ranges use source FPS and speed rather than timeline frames as source frames', () => {
  const project = createProject([
    {
      id: 'clip-a',
      type: 'video',
      trackId: 'video-track',
      mediaId: 'source',
      from: 0,
      durationInFrames: 30,
      sourceStart: 600,
      sourceFps: 60,
      speed: 2,
      sourceDuration: 3600,
    },
    {
      id: 'clip-b',
      type: 'video',
      trackId: 'video-track',
      mediaId: 'source',
      from: 30,
      durationInFrames: 30,
      sourceStart: 680,
      sourceFps: 60,
      sourceDuration: 3600,
    },
  ])
  project.metadata = { fps: 30 }
  const result = auditRemixProject(project)
  const range = result.semanticFacts.sourceRanges[0]
  assert.deepEqual(range.frames, { from: 600, to: 720 })
  assert.deepEqual(range.seconds, { from: 10, to: 12 })
  assert.equal(range.sourceDurationSeconds, 60)
  assert.ok(
    Math.abs(
      result.issues.find((entry) => entry.code === 'source_range_overlap').details.overlapRatio -
        2 / 3,
    ) < 1e-12,
  )
})

test('linked audio/video at different source frame rates compare their seconds', () => {
  const common = { mediaId: 'source', linkedGroupId: 'pair', from: 0, durationInFrames: 30 }
  const project = createProject([
    {
      ...common,
      id: 'video',
      type: 'video',
      trackId: 'video-track',
      sourceFps: 60,
      sourceStart: 600,
      sourceEnd: 660,
    },
    {
      ...common,
      id: 'audio',
      type: 'audio',
      trackId: 'audio-track',
      sourceFps: 30,
      sourceStart: 300,
      sourceEnd: 330,
    },
  ])
  project.metadata = { fps: 30 }
  assert.equal(auditRemixProject(project).ok, true)
})

test('bounds include the frames playback requires at the selected speed, including reverse', () => {
  const result = auditRemixProject(
    createProject([
      {
        id: 'fast',
        type: 'video',
        trackId: 'video-track',
        from: 0,
        durationInFrames: 30,
        sourceStart: 600,
        sourceEnd: 660,
        sourceFps: 60,
        speed: 2,
        sourceDuration: 700,
      },
      {
        id: 'reverse',
        type: 'video',
        trackId: 'other',
        from: 0,
        durationInFrames: 30,
        sourceStart: 0,
        sourceEnd: 60,
        sourceFps: 60,
        speed: 2,
        sourceDuration: 700,
        isReversed: true,
      },
    ]),
  )
  assert.equal(result.errorCount, 2)
  assert.ok(result.issues.every((entry) => entry.code === 'source_range_out_of_bounds'))
})

test('audit reports a truthful read-only rule outcome with messages and a bounded scope', () => {
  const project = createProject([
    { id: 'a', type: 'video', trackId: 'video-track', from: 0, durationInFrames: 30 },
    { id: 'b', type: 'video', trackId: 'video-track', from: 60, durationInFrames: 30 },
  ])
  const before = JSON.stringify(project)
  const result = auditRemixProject(project, { revision: 'sha256:original' })
  assert.equal(result.status, 'failed')
  assert.equal(result.executionStatus, 'completed')
  assert.equal(result.readOnly, true)
  assert.equal(result.revision, 'sha256:original')
  assert.equal(result.errorCount, 1)
  assert.deepEqual(result.issues[0].trackIds, ['video-track'])
  assert.match(result.issues[0].message, /gap/)
  assert.match(result.issues[0].repairHint, /track/)
  assert.ok(result.notChecked.includes('rendered_output'))
  assert.equal(JSON.stringify(project), before)
  assert.equal(auditRemixProject(project, { trackId: 'missing' }).status, 'failed')
})

test('static overlays and hard cuts are observations, and unlinked narration/SFX are not called BGM', () => {
  const project = createProject([
    { id: 'a', type: 'video', trackId: 'video-track', from: 0, durationInFrames: 30 },
    { id: 'b', type: 'video', trackId: 'video-track', from: 30, durationInFrames: 30 },
    { id: 'overlay', type: 'image', trackId: 'overlay-track', from: 0, durationInFrames: 60 },
    { id: 'narration', type: 'audio', trackId: 'audio-track', from: 0, durationInFrames: 25 },
    { id: 'click', type: 'audio', trackId: 'audio-track', from: 30, durationInFrames: 2 },
  ])
  const result = auditRemixProject(project)
  assert.equal(result.status, 'passed')
  assert.equal(result.errorCount, 0)
  assert.deepEqual(
    result.semanticFacts.findings.map(({ severity, requiresAction }) => ({
      severity,
      requiresAction,
    })),
    [
      { severity: 'observation', requiresAction: false },
      { severity: 'observation', requiresAction: false },
    ],
  )
  assert.deepEqual(result.semanticFacts.audio.tracks[0].unlinkedAudioItemIds, [
    'narration',
    'click',
  ])
  assert.equal(result.semanticFacts.audio.tracks[0].contentRole, 'unknown')
  assert.equal(result.semanticFacts.audio.unlinkedAudioCoverage.frames, 27)
  assert.match(result.summary, /not been verified/)
})
