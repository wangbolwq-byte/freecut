interface PropertyValueScrubOptions {
  startValue: number
  deltaX: number
  decimals: number
  min?: number
  max?: number
  shiftKey?: boolean
  altKey?: boolean
}

export function getScrubbedPropertyValue({
  startValue,
  deltaX,
  decimals,
  min = -Infinity,
  max = Infinity,
  shiftKey = false,
  altKey = false,
}: PropertyValueScrubOptions): { value: number; display: string } {
  const modifier = altKey ? 0.01 : shiftKey ? 0.1 : 1
  const precision = Math.min(8, decimals + (altKey ? 2 : shiftKey ? 1 : 0))
  const step = 10 ** -decimals
  const unclamped = startValue + deltaX * step * modifier
  const clamped = Math.max(min, Math.min(max, unclamped))
  const value = Number(clamped.toFixed(precision))

  return { value, display: value.toFixed(precision) }
}
