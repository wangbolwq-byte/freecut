import { describe, expect, it } from 'vite-plus/test'
import { configureCorsMediaElement } from './media-element-cors'

describe('configureCorsMediaElement', () => {
  it('sets anonymous CORS mode before assigning src', () => {
    const writes: string[] = []
    const element = {
      get crossOrigin() {
        return null
      },
      set crossOrigin(value: string | null) {
        writes.push(`crossOrigin:${value}`)
      },
      get src() {
        return ''
      },
      set src(value: string) {
        writes.push(`src:${value}`)
      },
    } as unknown as HTMLMediaElement

    configureCorsMediaElement(element, 'http://127.0.0.1:54321/media/source.mp4')

    expect(writes).toEqual(['crossOrigin:anonymous', 'src:http://127.0.0.1:54321/media/source.mp4'])
  })
})
