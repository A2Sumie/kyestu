import type { Component } from '../core/types'
import { MediaStore } from '../pipeline/media'

export const mediaStoreComponent: Component<{ cache_root?: string }> = {
  knownWithKeys: ['cache_root'],
  apply: (ctx, config) => {
    ctx.set('media-store', new MediaStore(config.cache_root ?? 'cache'))
  },
}
