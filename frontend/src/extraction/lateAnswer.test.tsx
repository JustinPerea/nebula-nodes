// region-notices-ratchet: off, this App is the standalone extraction page's, not the app's notice region
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
  const at = (folder: string, id: string) => ({ folder, id })
  it('takes an answer only for the record it was asked for, in the folder it was asked in', () => {
    const shown = detail(B)
    expect(acceptDetail(shown, detail(A), at('/f', A.id), at('/f', B.id))).toBe(shown)
    const fresh = detail(B)
    expect(acceptDetail(shown, fresh, at('/f', B.id), at('/f', B.id))).toBe(fresh)
    expect(acceptDetail(shown, fresh, at('/f', B.id), null)).toBe(shown)
  })

  it('refuses the same id answered for another folder', () => {
    const shown = detail(A)
    const fresh = detail(A)
    expect(acceptDetail(shown, fresh, at('/one', A.id), at('/two', A.id))).toBe(shown)
    expect(acceptDetail(shown, fresh, at('/two', A.id), at('/two', A.id))).toBe(fresh)
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

  it('leaves the same image opened from another folder alone (one id in two folders)', async () => {
    // The image hash is the id, so folder two holds A too, under another name.
    const other = unread(A.id, 'other-folder.png')
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const inOther = url.includes(`folder=${encodeURIComponent('/other')}`) || url.includes(`path=${encodeURIComponent('/other')}`)
      if (url.startsWith('/api/folder')) {
        return Promise.resolve(json({ folder: inOther ? '/other' : '/records', records: [{ id: A.id, name: inOther ? 'other-folder.png' : 'a.png' }] }))
      }
      if (url.includes('/rendering')) return Promise.resolve(new Response(new Blob(['png'])))
      if (url.endsWith('/read') && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          finishRead = resolve
        })
      }
      if (url.startsWith(`/api/records/${A.id}`)) return Promise.resolve(json(detail(inOther ? other : A)))
      return Promise.resolve(new Response('{}', { status: 404 }))
    }))
    render(<App token="t" />)
    fireEvent.click(await screen.findByRole('button', { name: /a\.png/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Read with Claude' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Read' }))

    fireEvent.change(screen.getByLabelText('Records folder'), { target: { value: '/other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use folder' }))
    fireEvent.click(await screen.findByRole('button', { name: /other-folder\.png/ }))
    await waitFor(() => expect(document.querySelector('.ex-side')?.textContent).toContain('other-folder.png'))

    // Folder one's read finishes now, for the same id.
    finishRead(json(detail({ ...A, structure: { ...A.structure, read: readRecord().structure.read } })))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const side = document.querySelector('.ex-side')!
    expect(side.textContent).toContain('other-folder.png')
    expect(side.textContent).not.toContain('a.png')
    expect(screen.queryAllByTestId('region-row')).toHaveLength(0) // folder one's reading didn't land here
  })
})

describe('the folder button', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('says what unlocks it while it is disabled', async () => {
    window.localStorage.removeItem('extraction.folder')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))))
    render(<App token="t" />)
    const button = screen.getByRole('button', { name: 'Use folder' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Records folder'), { target: { value: '  ' } })
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('You can use a folder after you type its path.')
    fireEvent.change(screen.getByLabelText('Records folder'), { target: { value: '/records' } })
    expect(button.disabled).toBe(false)
    expect(button.hasAttribute('title')).toBe(false)
  })
})
