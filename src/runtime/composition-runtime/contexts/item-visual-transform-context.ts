import { createContext, useContext } from 'react'
import type { ResolvedTransform } from '@/types/transform'

const ItemVisualTransformContext = createContext<ResolvedTransform | null>(null)

export const ItemVisualTransformProvider = ItemVisualTransformContext.Provider

export function useItemVisualTransform(): ResolvedTransform | null {
  return useContext(ItemVisualTransformContext)
}
