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
