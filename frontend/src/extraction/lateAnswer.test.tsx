import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { acceptDetail } from './detail'
import type { RecordDetail } from './api'
import { readRecord } from './testRecord'
import type { ExtractionRecord } from './types'

function unread(id: string, name: string): ExtractionRecord {
  const record = readRecord()
  return { ...record, id, source: { ...record.source, name }, structure: { ...record.structure, read: null } }
}

const A = unread('ex_aaaaaaaaaaaaaaaa', 'a.png')
const B = unread('ex_bbbbbbbbbbbbbbbb', 'b.png')
const detail = (record: ExtractionRecord): RecordDetail => ({ record, effective: record })
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('acceptDetail', () => {
  it('takes an answer only for the selected record', () => {
    const shown = detail(B)
    expect(acceptDetail(shown, detail(A), B.id)).toBe(shown)
    const fresh = detail(B)
    expect(acceptDetail(shown, fresh, B.id)).toBe(fresh)
  })
})

describe('a read that finishes after another record is opened', () => {
  let finishRead: (value: Response) => void = () => {}

  beforeEach(() => {
    window.localStorage.setItem('extraction.folder', '/records')
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/folder')) {
        return Promise.resolve(json({ folder: '/records', records: [{ id: A.id, name: 'a.png' }, { id: B.id, name: 'b.png' }] }))
      }
      if (url.includes('/rendering')) return Promise.resolve(new Response(new Blob(['png'])))
      if (url.endsWith('/read') && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          finishRead = resolve
        })
      }
      if (url.startsWith(`/api/records/${A.id}`)) return Promise.resolve(json(detail(A)))
      if (url.startsWith(`/api/records/${B.id}`)) return Promise.resolve(json(detail(B)))
      return Promise.resolve(new Response('{}', { status: 404 }))
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('leaves the record the person opened on screen', async () => {
    render(<App token="t" />)
    fireEvent.click(await screen.findByRole('button', { name: /a\.png/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Read with Claude' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Read' }))

    fireEvent.click(screen.getByRole('button', { name: /b\.png/ }))
    await waitFor(() => expect(document.querySelector('.ex-side')?.textContent).toContain('b.png'))

    const readA = { ...A, structure: { ...A.structure, read: readRecord().structure.read } }
    finishRead(json(detail(readA)))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const side = document.querySelector('.ex-side')
    expect(side).not.toBeNull()
    expect(side!.textContent).toContain('b.png')
    expect(side!.textContent).not.toContain('a.png')
  })
})
