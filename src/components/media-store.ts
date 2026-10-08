import type { Component } from '../core/types'
import { MediaStore } from '../pipeline/media'
import type { UrlPolicy } from '../pipeline/net-guard'

export const mediaStoreComponent: Component<{ cache_root?: string; url_policy?: UrlPolicy }> = {
  knownWithKeys: ['cache_root', 'url_policy'],
  apply: (ctx, config) => {
    // url_policy is the outbound-destination escape hatch (daybreak finding 4):
    // block-private (default) refuses loopback/private/metadata media urls,
    // allow-private is for test rigs and operator setups that really do serve
    // media from inside the network. Env fallback: KYESTU_URL_POLICY.
    const urlPolicy: UrlPolicy | undefined =
      config.url_policy === 'allow-private' || config.url_policy === 'block-private' ? config.url_policy : undefined
    ctx.set('media-store', new MediaStore(config.cache_root ?? 'cache', { urlPolicy }))
  },
}
