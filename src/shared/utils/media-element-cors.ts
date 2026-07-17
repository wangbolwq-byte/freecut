/**
 * Prepare a media element for use with Web Audio before a network request starts.
 *
 * MediaElementAudioSourceNode outputs silence for cross-origin media that was
 * loaded without CORS mode, even when the element can play the resource directly.
 * Keep this call ahead of assigning `src` or calling `load()`.
 */
export function configureCorsMediaElement(element: HTMLMediaElement, sourceUrl?: string): void {
  element.crossOrigin = 'anonymous'
  if (sourceUrl !== undefined && element.src !== sourceUrl) {
    element.src = sourceUrl
  }
}
