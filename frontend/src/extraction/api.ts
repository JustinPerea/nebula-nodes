import type { ExtractionRecord, FolderListing, SourceKind } from './types'

export const TOKEN_HEADER = 'X-Extraction-Token'

/** A refusal or failure the page can show: one plain sentence. */
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface RecordDetail {
  record: ExtractionRecord
  effective: ExtractionRecord
}

export interface Api {
  folder(path: string): Promise<FolderListing>
  addRecord(folder: string, file: File, kind: SourceKind): Promise<{ record: ExtractionRecord; existed: boolean }>
  record(id: string, folder: string): Promise<RecordDetail>
  rendering(id: string, folder: string): Promise<Blob>
}

const NO_ANSWER = 'The server didn’t answer. Check that it is still running.'
const UNREADABLE = 'The server’s answer couldn’t be read.'

/** The server's calls. Every one sends the launch token in its header. */
export function createApi(token: string, fetchFn: typeof fetch = (...args) => fetch(...args)): Api {
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await fetchFn(url, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: token } })
    } catch {
      throw new ApiError(NO_ANSWER, 0)
    }
    if (response.ok) return response
    let message = 'That request was refused.'
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string' && body.error) message = body.error
    } catch {
      // Keep the general sentence.
    }
    throw new ApiError(message, response.status)
  }

  async function json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T
    } catch {
      throw new ApiError(UNREADABLE, response.status)
    }
  }

  const query = (folder: string) => `folder=${encodeURIComponent(folder)}`

  return {
    async folder(path) {
      return json<FolderListing>(await call(`/api/folder?path=${encodeURIComponent(path)}`))
    },
    async addRecord(folder, file, kind) {
      const form = new FormData()
      form.set('folder', folder)
      form.set('kind', kind)
      form.set('name', file.name)
      form.set('file', file, file.name)
      return json(await call('/api/records', { method: 'POST', body: form }))
    },
    async record(id, folder) {
      return json<RecordDetail>(await call(`/api/records/${encodeURIComponent(id)}?${query(folder)}`))
    },
    async rendering(id, folder) {
      return (await call(`/api/records/${encodeURIComponent(id)}/rendering?${query(folder)}`)).blob()
    },
  }
}
