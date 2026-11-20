import { useEffect, useState } from 'react'
import type { Api } from './api'

const cache = new Map<string, Promise<string>>()

/** A blob URL for a record's saved rendering. The fetch carries the token, so an <img> can't do it. */
export function loadRendering(api: Api, folder: string, id: string): Promise<string> {
  const key = `${folder}\n${id}`
  const hit = cache.get(key)
  if (hit) return hit
  const pending = api.rendering(id, folder).then((blob) => URL.createObjectURL(blob))
  cache.set(key, pending)
  pending.catch(() => cache.delete(key))
  return pending
}

/** Free every kept rendering (the page is closing or the folder changed). */
export function releaseRenderings(): void {
  for (const pending of cache.values()) pending.then((url) => URL.revokeObjectURL(url), () => {})
  cache.clear()
}

/** The rendering's blob URL once loaded, null before that or when it can't be read. */
export function useRendering(api: Api, folder: string, id: string): string | null {
  const key = `${folder}\n${id}`
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null)
  useEffect(() => {
    let live = true
    loadRendering(api, folder, id).then(
      (url) => {
        if (live) setLoaded({ key, url })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, folder, id, key])
  return loaded && loaded.key === key ? loaded.url : null
}
