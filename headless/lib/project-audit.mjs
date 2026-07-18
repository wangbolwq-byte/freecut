const TIMED_MEDIA_TYPES = new Set(['video', 'audio'])

export function auditRemixProject(project, options = {}) {
  const timeline = project?.timeline ?? {}
  const tracks = new Map((timeline.tracks ?? []).map((track) => [track.id, track]))
  const items = (timeline.items ?? []).filter(
    (item) => !options.trackId || item.trackId === options.trackId,
  )
  const issues = []

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

  return {
    ok: issues.length === 0,
    mode: 'remix',
    projectId: project?.id,
    issues,
    metrics: {
      itemCount: items.length,
      duplicateRangeCount,
      frontLoadedRangeCount,
    },
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
