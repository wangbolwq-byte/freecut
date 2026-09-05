const TIMED_MEDIA_TYPES = new Set(['video', 'audio'])
const SPARSE_VISUAL_TRACK_ROLES = new Set(['overlay', 'motion-graphics', 'captions'])

export function auditRemixProject(project, options = {}) {
  const timeline = project?.timeline ?? {}
  const projectFps = positiveNumber(project?.metadata?.fps, 30)
  const tracks = new Map((timeline.tracks ?? []).map((track) => [track.id, track]))
  const items = (timeline.items ?? []).filter(
    (item) => !options.trackId || item.trackId === options.trackId,
  )
  const issues = []
  const uncoveredCuts = []
  if (options.trackId && !tracks.has(options.trackId))
    issues.push(issue('audit_track_not_found', [], { trackId: options.trackId }))
  const sourceRanges = items
    .filter((item) => TIMED_MEDIA_TYPES.has(item.type))
    .map((item) => sourceRange(item, projectFps))
  for (const range of sourceRanges) {
    if (
      range.seconds.from < 0 ||
      range.seconds.to < range.seconds.from ||
      range.requiredPlaybackFrames.from < -1 ||
      (range.sourceDurationFrames !== null &&
        (range.frames.to > range.sourceDurationFrames + 1 ||
          range.requiredPlaybackFrames.to > range.sourceDurationFrames + 1))
    ) {
      issues.push(issue('source_range_out_of_bounds', [range.itemId], { sourceRange: range }))
    }
  }

  for (const [trackId, trackItems] of groupBy(items, (item) => item.trackId)) {
    const track = tracks.get(trackId)
    if ((track?.kind ?? 'video') !== 'video') continue
    const ordered = trackItems
      .filter((item) => item.type === 'video' || item.type === 'image')
      .sort((left, right) => (left.from ?? 0) - (right.from ?? 0))
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]
      const current = ordered[index]
      const previousEnd = (previous.from ?? 0) + (previous.durationInFrames ?? 0)
      const currentStart = current.from ?? 0
      if (currentStart > previousEnd && !SPARSE_VISUAL_TRACK_ROLES.has(track?.role)) {
        issues.push(
          issue('timeline_gap', [previous.id, current.id], { frames: currentStart - previousEnd }),
        )
      } else if (currentStart < previousEnd) {
        issues.push(
          issue('timeline_overlap', [previous.id, current.id], {
            frames: previousEnd - currentStart,
          }),
        )
      }
      if (
        currentStart === previousEnd &&
        track?.kind !== 'audio' &&
        isVisualItem(previous) &&
        isVisualItem(current)
      ) {
        const transition = (timeline.transitions ?? []).find(
          (entry) => entry.leftClipId === previous.id && entry.rightClipId === current.id,
        )
        if (!transition) {
          uncoveredCuts.push({
            leftClipId: previous.id,
            rightClipId: current.id,
            trackId,
            cutFrame: currentStart,
          })
        }
      }
    }
  }

  for (const [linkedGroupId, linkedItems] of groupBy(
    items.filter((item) => item.linkedGroupId),
    (item) => item.linkedGroupId,
  )) {
    const video = linkedItems.find((item) => item.type === 'video')
    const audio = linkedItems.find((item) => item.type === 'audio')
    if (!video || !audio) continue
    const fields = ['from', 'durationInFrames']
    const mismatches = fields.filter((field) => (video[field] ?? 0) !== (audio[field] ?? 0))
    const videoRange = sourceInterval(video, projectFps)
    const audioRange = sourceInterval(audio, projectFps)
    if (Math.abs(videoRange.start - audioRange.start) > 1 / projectFps)
      mismatches.push('sourceStartSeconds')
    if (Math.abs(videoRange.end - audioRange.end) > 1 / projectFps)
      mismatches.push('sourceEndSeconds')
    if (mismatches.length > 0) {
      issues.push(
        issue('av_source_range_mismatch', [video.id, audio.id], { linkedGroupId, mismatches }),
      )
    }
  }

  let duplicateRangeCount = 0
  let frontLoadedRangeCount = 0
  for (const [mediaId, mediaItems] of groupBy(
    items.filter((item) => TIMED_MEDIA_TYPES.has(item.type) && item.mediaId),
    (item) => item.mediaId,
  )) {
    const visualItems = mediaItems.filter((item) => item.type === 'video')
    if (visualItems.length < 2) continue
    const timelineOrdered = [...visualItems].sort(
      (left, right) => (left.from ?? 0) - (right.from ?? 0),
    )
    for (let index = 1; index < timelineOrdered.length; index += 1) {
      if (
        sourceInterval(timelineOrdered[index], projectFps).start <
        sourceInterval(timelineOrdered[index - 1], projectFps).start
      ) {
        issues.push(
          issue(
            'source_range_not_monotonic',
            [timelineOrdered[index - 1].id, timelineOrdered[index].id],
            { mediaId },
          ),
        )
      }
    }
    const ordered = visualItems.sort(
      (left, right) =>
        sourceInterval(left, projectFps).start - sourceInterval(right, projectFps).start,
    )
    const beginningItems = ordered.filter((item) => (item.sourceStart ?? 0) <= 1)
    if (beginningItems.length > 1) {
      issues.push(
        issue(
          'source_beginning_reused',
          beginningItems.map((item) => item.id),
          { mediaId, count: beginningItems.length },
        ),
      )
    }
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const left = sourceInterval(ordered[leftIndex], projectFps)
        const right = sourceInterval(ordered[rightIndex], projectFps)
        const overlap = Math.max(
          0,
          Math.min(left.end, right.end) - Math.max(left.start, right.start),
        )
        const shorter = Math.max(
          Number.EPSILON,
          Math.min(left.end - left.start, right.end - right.start),
        )
        if (overlap / shorter > 0.1) {
          duplicateRangeCount += 1
          issues.push(
            issue('source_range_overlap', [ordered[leftIndex].id, ordered[rightIndex].id], {
              mediaId,
              overlapRatio: overlap / shorter,
              overlapSeconds: overlap,
            }),
          )
        }
      }
    }
    const sourceDuration = Math.max(
      ...ordered.map(
        (item) => (item.sourceDuration ?? 0) / positiveNumber(item.sourceFps, projectFps),
      ),
    )
    if (ordered.length >= 3 && sourceDuration > 0) {
      const frontLimit = Math.max(1 / projectFps, sourceDuration * 0.1)
      const frontLoaded = ordered.filter(
        (item) => sourceInterval(item, projectFps).start <= frontLimit,
      )
      frontLoadedRangeCount += frontLoaded.length
      if (frontLoaded.length === ordered.length) {
        issues.push(
          issue(
            'source_ranges_front_loaded',
            frontLoaded.map((item) => item.id),
            {
              mediaId,
              frontLimit,
              unit: 'seconds',
            },
          ),
        )
      }
      const totalRequested = ordered.reduce(
        (total, item) =>
          total +
          Math.max(
            0,
            sourceInterval(item, projectFps).end - sourceInterval(item, projectFps).start,
          ),
        0,
      )
      if (totalRequested > sourceDuration * 1.1) {
        issues.push(
          issue(
            'insufficient_unique_source_range',
            ordered.map((item) => item.id),
            {
              mediaId,
              totalRequested,
              sourceDuration,
              unit: 'seconds',
            },
          ),
        )
      }
    }
  }

  const semanticFacts = collectSemanticFacts({ timeline, tracks, items, uncoveredCuts })
  const itemById = new Map(items.map((item) => [item.id, item]))

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? 'passed' : 'failed',
    executionStatus: 'completed',
    readOnly: true,
    ...(options.revision ? { revision: options.revision } : {}),
    summary:
      issues.length === 0
        ? 'Structural remix audit passed. Visual quality, sound quality, and rendered output have not been verified.'
        : `Structural remix audit failed with ${issues.length} rule error(s). The project was not modified; observations are not additional failures.`,
    errorCount: issues.length,
    warningCount: 0,
    scope: { trackId: options.trackId ?? null, itemCount: items.length },
    notChecked: [
      'visual_quality',
      'speech_intelligibility',
      'audio_loudness',
      'sensitive_information',
      'rendered_output',
      'content_alignment_with_editing_plan',
    ],
    mode: 'remix',
    projectId: project?.id,
    issues: issues.map((entry) => ({
      ...entry,
      trackIds: [...new Set(entry.itemIds.map((id) => itemById.get(id)?.trackId).filter(Boolean))],
    })),
    semanticFacts: {
      ...semanticFacts,
      sourceRanges,
      units: {
        timeline: 'project_frames',
        projectFps,
        source: 'source_frames',
        sourceSecondsConversion: 'sourceFrame / sourceFps',
      },
    },
    metrics: {
      itemCount: items.length,
      duplicateRangeCount,
      frontLoadedRangeCount,
    },
  }
}

function collectSemanticFacts({ timeline, tracks, items, uncoveredCuts }) {
  const itemById = new Map(items.map((item) => [item.id, item]))
  const positionAnimations = (timeline.keyframes ?? []).flatMap((entry) => {
    const properties = (entry.properties ?? []).filter(
      (property) => property.property === 'x' || property.property === 'y',
    )
    if (properties.length === 0) return []
    const axes = Object.fromEntries(
      properties.map((property) => {
        const values = (property.keyframes ?? []).map((keyframe) => keyframe.value)
        return [
          property.property,
          {
            keyframes: property.keyframes ?? [],
            displacement: values.length > 0 ? Math.max(...values) - Math.min(...values) : 0,
          },
        ]
      }),
    )
    const displacement = Math.hypot(axes.x?.displacement ?? 0, axes.y?.displacement ?? 0)
    return [{ itemId: entry.itemId, axes, displacement, hasActualMotion: displacement > 0 }]
  })
  const animationByItem = new Map(positionAnimations.map((entry) => [entry.itemId, entry]))
  const overlayPositions = items
    .filter((item) => item.type === 'image' || item.type === 'lottie')
    .map((item) => ({
      itemId: item.id,
      itemType: item.type,
      from: item.from ?? 0,
      to: (item.from ?? 0) + (item.durationInFrames ?? 0),
      positionAnimation: animationByItem.get(item.id) ?? null,
    }))
  const transitions = (timeline.transitions ?? []).map((transition) => {
    const left = itemById.get(transition.leftClipId)
    const right = itemById.get(transition.rightClipId)
    const cutFrame =
      right?.from ??
      (left?.from ?? 0) + (left?.durationInFrames ?? transition.durationInFrames ?? 0)
    const duration = transition.durationInFrames ?? 0
    const alignment = transition.alignment ?? 0.5
    const beforeCut = Math.round(duration * alignment)
    return {
      id: transition.id,
      type: transition.type,
      presentation: transition.presentation,
      leftClipId: transition.leftClipId,
      rightClipId: transition.rightClipId,
      durationInFrames: duration,
      coverage: {
        from: cutFrame - beforeCut,
        to: cutFrame - beforeCut + duration,
      },
    }
  })
  const audioTracks = [...tracks.values()]
    .filter((track) => (track.kind ?? 'video') === 'audio')
    .map((track) => {
      const trackItems = items.filter((item) => item.trackId === track.id && item.type === 'audio')
      const sourceAudioItems = trackItems.filter((item) => item.linkedGroupId)
      const unlinkedItems = trackItems.filter((item) => !item.linkedGroupId)
      return {
        trackId: track.id,
        name: track.name,
        muted: track.muted === true,
        volumeDb: track.volume ?? 0,
        sourceAudioItemIds: sourceAudioItems.map((item) => item.id),
        unlinkedAudioItemIds: unlinkedItems.map((item) => item.id),
        contentRole: 'unknown',
        coverage: intervalCoverage(trackItems),
        unlinkedAudioCoverage: intervalCoverage(unlinkedItems),
      }
    })
  const gpuEffects = items.flatMap((item) =>
    (item.effects ?? [])
      .filter((effect) => effect.enabled !== false)
      .map((effect) => ({
        itemId: item.id,
        effectId: effect.id,
        gpuEffectType: effect.effect?.gpuEffectType,
        coverage: {
          from: item.from ?? 0,
          to: (item.from ?? 0) + (item.durationInFrames ?? 0),
        },
      })),
  )
  const durationFrames = Math.max(
    0,
    ...items.map((item) => (item.from ?? 0) + (item.durationInFrames ?? 0)),
  )
  const unlinkedAudioCoverage = intervalCoverage(
    items.filter((item) => item.type === 'audio' && !item.linkedGroupId),
  )
  const findings = [
    ...overlayPositions
      .filter((item) => !item.positionAnimation?.hasActualMotion)
      .map((item) => ({
        code: 'static_overlay_position',
        itemIds: [item.itemId],
        fact: 'Overlay has no distinct x/y keyframe values.',
      })),
    ...uncoveredCuts.map((cut) => ({
      code: 'cut_without_transition',
      itemIds: [cut.leftClipId, cut.rightClipId],
      fact: 'Adjacent visual clips meet at a cut with no transition record.',
      cutFrame: cut.cutFrame,
    })),
    ...(timeline.masterBusDb <= -59 && audioTracks.some((track) => !track.muted)
      ? [
          {
            code: 'master_bus_effectively_silent',
            itemIds: [],
            fact: 'The master bus is effectively silent while one or more audio tracks remain unmuted.',
          },
        ]
      : []),
  ]
  return {
    positionAnimations,
    overlayPositions,
    transitions,
    uncoveredCuts,
    audio: {
      masterBusDb: timeline.masterBusDb ?? 0,
      volumeUnit: 'dB',
      zeroDbMeaning: 'unity_gain',
      tracks: audioTracks,
      unlinkedAudioCoverage,
      roleClassification: 'unknown_without_explicit_production_manifest',
      projectDurationFrames: durationFrames,
    },
    gpuEffects,
    findings: findings.map((finding) => ({
      ...finding,
      severity: 'observation',
      requiresAction: false,
    })),
  }
}

function isVisualItem(item) {
  return (
    item.type === 'video' || item.type === 'image' || item.type === 'text' || item.type === 'lottie'
  )
}

function intervalCoverage(items) {
  const intervals = items
    .map((item) => ({
      from: item.from ?? 0,
      to: (item.from ?? 0) + (item.durationInFrames ?? 0),
    }))
    .filter((interval) => interval.to > interval.from)
    .sort((left, right) => left.from - right.from)
  const merged = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (!previous || interval.from > previous.to) merged.push({ ...interval })
    else previous.to = Math.max(previous.to, interval.to)
  }
  return {
    ranges: merged,
    frames: merged.reduce((total, interval) => total + interval.to - interval.from, 0),
  }
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function sourceRange(item, projectFps) {
  const sourceFps = positiveNumber(item.sourceFps, projectFps)
  const speed = positiveNumber(item.speed, 1)
  const from = item.sourceStart ?? 0
  const requiredFrames = Math.round(((item.durationInFrames ?? 0) / projectFps) * sourceFps * speed)
  const to = item.sourceEnd ?? from + requiredFrames
  const requiredPlaybackFrames = item.isReversed
    ? { from: to - requiredFrames, to }
    : { from, to: from + requiredFrames }
  return {
    itemId: item.id,
    mediaId: item.mediaId ?? null,
    trackId: item.trackId,
    sourceFps,
    sourceFpsOrigin:
      positiveNumber(item.sourceFps, null) === null ? 'project_fps_fallback' : 'item',
    projectFps,
    speed,
    reversed: item.isReversed === true,
    frames: { from, to },
    seconds: { from: from / sourceFps, to: to / sourceFps },
    requiredPlaybackFrames,
    sourceDurationFrames:
      typeof item.sourceDuration === 'number' && item.sourceDuration > 0
        ? item.sourceDuration
        : null,
    sourceDurationSeconds:
      typeof item.sourceDuration === 'number' && item.sourceDuration > 0
        ? item.sourceDuration / sourceFps
        : null,
  }
}

function sourceInterval(item, projectFps) {
  const range = sourceRange(item, projectFps)
  return { start: range.seconds.from, end: range.seconds.to }
}

function groupBy(values, keyOf) {
  const grouped = new Map()
  for (const value of values) {
    const key = keyOf(value)
    if (!key) continue
    grouped.set(key, [...(grouped.get(key) ?? []), value])
  }
  return grouped
}

function issue(code, itemIds, details) {
  const descriptions = {
    audit_track_not_found: [
      'The requested audit track does not exist.',
      'Choose an existing track or omit trackId to audit the whole project.',
    ],
    timeline_gap: [
      'Visual clips on the same track have a gap.',
      'Review this track and close the gap if it is intended to be continuous.',
    ],
    timeline_overlap: [
      'Visual clips overlap on the same track.',
      'Review the listed clip positions and durations.',
    ],
    av_source_range_mismatch: [
      'Linked audio and video do not use matching timeline/source time ranges.',
      'Align the linked ranges, using source FPS for source frames.',
    ],
    source_range_not_monotonic: [
      'This remix rule requires source order, but these clips move backward in source time.',
      'Check the selected source times against the editing plan before changing their order.',
    ],
    source_beginning_reused: [
      'Multiple clips reuse the beginning of the same source.',
      'Verify selected source seconds were converted to source frames and inspect the intended shots.',
    ],
    source_range_overlap: [
      'These clips reuse more than ten percent of the shorter source range.',
      'Review the listed source ranges against the intended shots; source frame units are not seconds.',
    ],
    source_ranges_front_loaded: [
      'All selected clips lie in the first ten percent of this source.',
      'Check the source analysis and seconds-to-source-frames conversion before changing shots.',
    ],
    insufficient_unique_source_range: [
      'Requested source ranges exceed the available source duration.',
      'Review repeated selections and choose valid source ranges.',
    ],
    source_range_out_of_bounds: [
      'A selected or required playback range exceeds the source bounds.',
      'Use the reported source FPS and speed to choose an in-bounds range.',
    ],
  }
  const [message, repairHint] = descriptions[code]
  return { code, severity: 'error', itemIds, message, repairHint, details }
}
