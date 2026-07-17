import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSettings } from './lib/render-core.mjs'

const project = { metadata: { width: 1920, height: 1080, fps: 60 } }

test('render presets cap dimensions, fps, bitrate, and encoder queue', () => {
  assert.deepEqual(buildSettings(project, { preset: 'draft' }), {
    mode: 'video',
    codec: 'avc',
    audioCodec: 'aac',
    container: 'mp4',
    quality: 'medium',
    resolution: { width: 1280, height: 720 },
    fps: 30,
    videoBitrate: 4_000_000,
    audioBitrate: 192_000,
    preset: 'draft',
    latencyMode: 'quality',
    hardwareAcceleration: 'prefer-hardware',
    maxEncoderQueue: 3,
  })

  const balanced = buildSettings(project, { preset: 'balanced' })
  assert.deepEqual(balanced.resolution, { width: 1920, height: 1080 })
  assert.equal(balanced.fps, 30)
  assert.equal(balanced.videoBitrate, 5_000_000)
  assert.equal(balanced.maxEncoderQueue, 3)

  const final = buildSettings(project, {})
  assert.deepEqual(final.resolution, { width: 1920, height: 1080 })
  assert.equal(final.fps, 60)
  assert.equal(final.videoBitrate, 10_000_000)
  assert.equal(final.maxEncoderQueue, 2)
})

test('explicit render settings override the selected preset', () => {
  const settings = buildSettings(project, {
    preset: 'draft',
    resolution: '640x360',
    fps: 24,
    quality: 'ultra',
  })

  assert.deepEqual(settings.resolution, { width: 640, height: 360 })
  assert.equal(settings.fps, 24)
  assert.equal(settings.quality, 'ultra')
  assert.equal(settings.videoBitrate, 20_000_000)
})
