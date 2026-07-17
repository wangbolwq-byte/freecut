import { describe, expect, it, vi } from 'vite-plus/test'
import type { LocalDirectoryBackend } from '@/infrastructure/storage/local-directory/types'
import type { Project } from '@/types/project'
import { loadDirectoryProjectSnapshot } from './directory-project-snapshot'

describe('loadDirectoryProjectSnapshot', () => {
  it('loads project media and detects same-size Agent rewrites without relying on mtime', async () => {
    const files = new Map<string, string | Uint8Array>()
    const project = createProject('Alpha')
    files.set('projects/project-1/project.json', JSON.stringify(project))
    files.set(
      'projects/project-1/media-links.json',
      JSON.stringify({ version: '1.0', mediaIds: [{ id: 'media-1', addedAt: 1 }] }),
    )
    files.set(
      'media/media-1/metadata.json',
      JSON.stringify({
        id: 'media-1',
        storageType: 'workspace',
        fileName: 'clip.mp4',
        fileSize: 3,
        mimeType: 'video/mp4',
        duration: 1,
        width: 640,
        height: 360,
        fps: 30,
        codec: 'avc1',
        bitrate: 1,
        tags: [],
      }),
    )
    files.set('media/media-1/clip.mp4', new Uint8Array([1, 2, 3]))
    files.set('media/media-1/thumbnail.jpg', new Uint8Array([4, 5]))
    const root = createDirectoryBackend(files)

    const initial = await loadDirectoryProjectSnapshot(root, 'project-1')
    files.set('projects/project-1/project.json', JSON.stringify(createProject('Bravo')))
    const updated = await loadDirectoryProjectSnapshot(root, 'project-1')

    expect(initial.media).toHaveLength(1)
    expect(initial.media[0]?.sourceFingerprint).toBe('3-fixed-mtime')
    expect(initial.missingMediaIds).toEqual(['missing-media'])
    expect(updated.project.name).toBe('Bravo')
    expect(updated.revision).not.toBe(initial.revision)
    expect(updated.projectRevision).not.toBe(initial.projectRevision)
  })
})

function createProject(name: string): Project {
  return {
    id: 'project-1',
    name,
    description: '',
    schemaVersion: 10,
    createdAt: 1,
    updatedAt: 1,
    duration: 30,
    metadata: { width: 640, height: 360, fps: 30, backgroundColor: '#000000' },
    timeline: {
      tracks: [],
      items: [
        {
          id: 'missing-item',
          type: 'video',
          mediaId: 'missing-media',
          trackId: 'track-1',
          from: 0,
          durationInFrames: 30,
          label: 'Missing clip',
        },
      ],
    },
  } as Project
}

function createDirectoryBackend(files: Map<string, string | Uint8Array>): LocalDirectoryBackend {
  const key = (path: readonly string[]) => path.join('/')
  return {
    kind: 'electron-directory',
    grantId: 'grant-1',
    name: 'autocut',
    readFile: async (path) => {
      const value = files.get(key(path))
      if (value === undefined) return null
      return {
        text: async () => (typeof value === 'string' ? value : new TextDecoder().decode(value)),
      } as Blob
    },
    getReadUrl: vi.fn(),
    writeFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    listDirectory: async (path) => {
      const prefix = `${key(path)}/`
      const names = new Set<string>()
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue
        const remainder = file.slice(prefix.length)
        const name = remainder.split('/')[0]
        if (name && !remainder.slice(name.length).includes('/')) names.add(name)
      }
      return [...names].map((name) => ({ name, kind: 'file' as const }))
    },
    createDirectory: vi.fn(),
    exists: async (path) => files.has(key(path)),
    stat: async (path) => {
      const value = files.get(key(path))
      if (value === undefined) return null
      const size = typeof value === 'string' ? value.length : value.byteLength
      return {
        kind: 'file',
        size,
        modifiedAt: 1,
        etag: `${size}-fixed-mtime`,
      }
    },
    move: vi.fn(),
    remove: vi.fn(),
    selectAndCopyFiles: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  }
}
