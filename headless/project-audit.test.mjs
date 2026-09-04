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
  assert.equal(facts.audio.backgroundMusicCoverage.frames, 120)
  assert.deepEqual(facts.gpuEffects[0].coverage, { from: 0, to: 90 })
  assert.ok(facts.findings.some((finding) => finding.code === 'background_music_undercoverage'))
  assert.equal(
    facts.findings.some((finding) => finding.code === 'static_overlay_position'),
    false,
  )
})
