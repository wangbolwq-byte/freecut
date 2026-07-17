import type { LocalDirectoryBackend } from '@/infrastructure/storage/local-directory/types'
import {
  mediaDir,
  mediaMetadataPath,
  mediaThumbnailPath,
  projectJsonPath,
  projectMediaLinksPath,
} from '@/infrastructure/storage/workspace-fs/paths'
import type { Project } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'

export interface DirectoryProjectSnapshot {
  revision: string
  projectRevision: string
  project: Project
  media: Array<{
    metadata: MediaMetadata
    fingerprint: string
    metadataFingerprint: string
    sourceFingerprint: string
    thumbnailFingerprint: string
  }>
  missingMediaIds: string[]
}

const NON_SOURCE_MEDIA_ENTRIES = new Set([
  'metadata.json',
  'thumbnail.jpg',
  'thumbnail.meta.json',
  'source.link.json',
  'cache',
])

/**
 * Build the same logical project snapshot as the standalone Headless service,
 * but through the active Electron directory grant. AutoCut Desktop does not
 * expose the workspace over HTTP, so the editor must reload external Agent
 * writes through this already-authorized bridge.
 */
export async function loadDirectoryProjectSnapshot(
  root: LocalDirectoryBackend,
  projectId: string,
): Promise<DirectoryProjectSnapshot> {
  const projectText = await readRequiredText(root, projectJsonPath(projectId), 'project')
  const project = parseRecord<Project>(projectText, 'project')
  if (project.id !== projectId) throw new Error('Project snapshot id does not match the route')

  const linksText = (await readOptionalText(root, projectMediaLinksPath(projectId))) ?? ''
  const linkedMediaIds = parseLinkedMediaIds(linksText)
  const mediaIds = new Set([...linkedMediaIds, ...timelineMediaIds(project)])
  const media: DirectoryProjectSnapshot['media'] = []
  const missingMediaIds: string[] = []
  const mediaRevisionParts: string[] = []

  for (const mediaId of [...mediaIds].sort()) {
    const metadataText = await readOptionalText(root, mediaMetadataPath(mediaId))
    if (!metadataText) {
      missingMediaIds.push(mediaId)
      mediaRevisionParts.push(`${mediaId}:missing`)
      continue
    }
    const metadata = parseRecord<MediaMetadata>(metadataText, `media ${mediaId}`)
    const metadataFingerprint = contentFingerprint(metadataText)
    const sourceFingerprint = await mediaSourceFingerprint(root, mediaId)
    const thumbnailFingerprint = await statFingerprint(root, mediaThumbnailPath(mediaId))
    const fingerprint = [metadataFingerprint, sourceFingerprint, thumbnailFingerprint].join('|')
    media.push({
      metadata,
      fingerprint,
      metadataFingerprint,
      sourceFingerprint,
      thumbnailFingerprint,
    })
    mediaRevisionParts.push(`${mediaId}:${fingerprint}`)
  }

  const projectRevision = contentFingerprint(projectText)
  return {
    revision: contentFingerprint(
      [projectText, linksText, mediaRevisionParts.join('\n')].join('\0'),
    ),
    projectRevision,
    project,
    media,
    missingMediaIds,
  }
}

async function readRequiredText(
  root: LocalDirectoryBackend,
  path: readonly string[],
  label: string,
): Promise<string> {
  const text = await readOptionalText(root, path)
  if (text === null) throw new Error(`${label} snapshot is missing`)
  return text
}

async function readOptionalText(
  root: LocalDirectoryBackend,
  path: readonly string[],
): Promise<string | null> {
  const blob = await root.readFile(path)
  return blob ? await blob.text() : null
}

function parseRecord<T>(text: string, label: string): T {
  const value = JSON.parse(text) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} snapshot is invalid`)
  }
  return value as T
}

function parseLinkedMediaIds(text: string): string[] {
  if (!text) return []
  const value = parseRecord<{ mediaIds?: unknown }>(text, 'project media links')
  if (!Array.isArray(value.mediaIds)) return []
  return value.mediaIds.flatMap((entry) => {
    if (typeof entry === 'string' && entry) return [entry]
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      typeof entry.id === 'string' &&
      entry.id
    ) {
      return [entry.id]
    }
    return []
  })
}

function timelineMediaIds(project: Project): string[] {
  const result = new Set<string>()
  const collect = (items: NonNullable<Project['timeline']>['items'] | undefined) => {
    for (const item of items ?? []) {
      if (
        (item.type === 'video' || item.type === 'audio' || item.type === 'image') &&
        item.mediaId
      ) {
        result.add(item.mediaId)
      }
    }
  }
  collect(project.timeline?.items)
  for (const composition of project.timeline?.compositions ?? []) collect(composition.items)
  return [...result]
}

async function mediaSourceFingerprint(
  root: LocalDirectoryBackend,
  mediaId: string,
): Promise<string> {
  const entries = await root.listDirectory(mediaDir(mediaId))
  const source = entries.find(
    (entry) => entry.kind === 'file' && !NON_SOURCE_MEDIA_ENTRIES.has(entry.name),
  )
  return source
    ? await statFingerprint(root, [...mediaDir(mediaId), source.name])
    : 'missing-source'
}

async function statFingerprint(
  root: LocalDirectoryBackend,
  path: readonly string[],
): Promise<string> {
  const stat = await root.stat(path)
  return stat ? stat.etag : 'missing'
}

function contentFingerprint(value: string): string {
  // Two independent 32-bit hashes keep this synchronous and deterministic in
  // every supported browser while avoiding mtime-only misses on rapid atomic
  // rewrites with the same byte length.
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `directory:${unsignedHex(first)}${unsignedHex(second)}`
}

function unsignedHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}
