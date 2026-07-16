import { describe, expect, it } from 'vite-plus/test'
import { normalizeEditorWorkspaceId } from './editor-workspaces'

describe('normalizeEditorWorkspaceId', () => {
  it('uses Motion as the workspace id and migrates the former Compose id', () => {
    expect(normalizeEditorWorkspaceId('motion')).toBe('motion')
    expect(normalizeEditorWorkspaceId('compose')).toBe('motion')
  })
})
