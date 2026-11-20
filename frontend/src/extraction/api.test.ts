import { describe, expect, it, vi } from 'vitest'
import { ApiError, createApi, TOKEN_HEADER } from './api'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

function headerOf(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit).headers).get(TOKEN_HEADER)
}

describe('createApi', () => {
  it('sends the token header on every call', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/rendering') ? new Response('png') : ok({ folder: '/f', records: [], record: {}, effective: {} }),
    )
    const api = createApi('secret-token', fetchFn)
    await api.folder('/f')
    await api.record('ex_0123456789abcdef', '/f')
    await api.rendering('ex_0123456789abcdef', '/f')
    await api.addRecord('/f', new File(['x'], 'a.png', { type: 'image/png' }), 'drop')
    expect(fetchFn).toHaveBeenCalledTimes(4)
    for (const call of fetchFn.mock.calls) expect(headerOf(call)).toBe('secret-token')
  })

  it('never puts the token in a URL', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok({ folder: '/f', records: [] }))
    await createApi('secret-token', fetchFn).folder('/f')
    expect(String(fetchFn.mock.calls[0][0])).not.toContain('secret-token')
  })

  it('posts the folder, kind, name and file as a form', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => ok({ record: {}, existed: false }))
    await createApi('t', fetchFn).addRecord('/f', new File(['x'], 'a.png'), 'paste')
    const init = fetchFn.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form.get('folder')).toBe('/f')
    expect(form.get('kind')).toBe('paste')
    expect(form.get('name')).toBe('a.png')
    expect((form.get('file') as File).name).toBe('a.png')
  })

  it("raises the server's own sentence", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: "That folder doesn't exist." }), { status: 400 }))
    const error = await createApi('t', fetchFn).folder('/nope').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe("That folder doesn't exist.")
    expect((error as ApiError).status).toBe(400)
  })

  it('says so when the server cannot be reached', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('network')
    })
    const error = await createApi('t', fetchFn).folder('/f').catch((e: unknown) => e)
    expect((error as ApiError).message).toMatch(/server didn’t answer/)
  })
})
