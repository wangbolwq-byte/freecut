const TIMED_MEDIA_TYPES = new Set(['video', 'audio'])

export function auditRemixProject(project, options = {}) {
  const timeline = project?.timeline ?? {}
  const tracks = new Map((timeline.tracks ?? []).map((track) => [track.id, track]))
  const items = (timeline.items ?? []).filter(
    (item) => !options.trackId || item.trackId === options.trackId,
  )
  const issues = []
  const uncoveredCuts = []

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
      if (currentStart > previousEnd) {
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
    const fields = ['from', 'durationInFrames', 'sourceStart', 'sourceEnd']
    const mismatches = fields.filter((field) => (video[field] ?? 0) !== (audio[field] ?? 0))
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
        (timelineOrdered[index].sourceStart ?? 0) < (timelineOrdered[index - 1].sourceStart ?? 0)
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
      (left, right) => (left.sourceStart ?? 0) - (right.sourceStart ?? 0),
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
        const left = sourceInterval(ordered[leftIndex])
        const right = sourceInterval(ordered[rightIndex])
        const overlap = Math.max(
          0,
          Math.min(left.end, right.end) - Math.max(left.start, right.start),
        )
        const shorter = Math.max(1, Math.min(left.end - left.start, right.end - right.start))
        if (overlap / shorter > 0.1) {
          duplicateRangeCount += 1
          issues.push(
            issue('source_range_overlap', [ordered[leftIndex].id, ordered[rightIndex].id], {
              mediaId,
              overlapRatio: overlap / shorter,
            }),
          )
        }
      }
    }
    const sourceDuration = Math.max(...ordered.map((item) => item.sourceDuration ?? 0))
    if (ordered.length >= 3 && sourceDuration > 0) {
      const frontLimit = Math.max(1, sourceDuration * 0.1)
      const frontLoaded = ordered.filter((item) => (item.sourceStart ?? 0) <= frontLimit)
      frontLoadedRangeCount += frontLoaded.length
      if (frontLoaded.length === ordered.length) {
        issues.push(
          issue(
            'source_ranges_front_loaded',
            frontLoaded.map((item) => item.id),
            {
              mediaId,
              frontLimit,
            },
          ),
        )
      }
      const totalRequested = ordered.reduce(
        (total, item) => total + Math.max(0, sourceInterval(item).end - sourceInterval(item).start),
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
            },
          ),
        )
      }
    }
  }

  const semanticFacts = collectSemanticFacts({ timeline, tracks, items, uncoveredCuts })

  return {
    ok: issues.length === 0,
    mode: 'remix',
    projectId: project?.id,
    issues,
    semanticFacts,
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
      const musicItems = trackItems.filter((item) => !item.linkedGroupId)
      return {
        trackId: track.id,
        name: track.name,
        muted: track.muted === true,
        volumeDb: track.volume ?? 0,
        sourceAudioItemIds: sourceAudioItems.map((item) => item.id),
        musicItemIds: musicItems.map((item) => item.id),
        coverage: intervalCoverage(trackItems),
        musicCoverage: intervalCoverage(musicItems),
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
  const musicCoverage = intervalCoverage(
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
            code: 'master_bus_used_for_source_mute',
            itemIds: [],
            fact: 'The master bus is effectively silent while one or more audio tracks remain unmuted.',
          },
        ]
      : []),
    ...(musicCoverage.frames < durationFrames
      ? [
          {
            code: 'background_music_undercoverage',
            itemIds: [],
            fact: `Unlinked audio covers ${musicCoverage.frames} of ${durationFrames} project frames.`,
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
      backgroundMusicCoverage: musicCoverage,
      projectDurationFrames: durationFrames,
    },
    gpuEffects,
    findings,
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

function sourceInterval(item) {
  const start = item.sourceStart ?? 0
  return { start, end: item.sourceEnd ?? start + (item.durationInFrames ?? 0) }
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
  return { code, severity: 'error', itemIds, details }
}
