import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createApi, TOKEN_HEADER } from './api'
import { CONFIRM_LINE, ReadSection } from './ReadSection'
import { RegionOverlay } from './RegionOverlay'
import { ReadingSection, RegionsSection, ShowsSection, SpacingSection, TextSection } from './Sections'
import { axisFill } from './read'
import { applied, readRecord } from './testRecord'
import type { Correction } from './types'

describe('RegionOverlay', () => {
  it('positions each box by its fractions and labels it with its role', () => {
    const record = readRecord()
    render(<RegionOverlay regions={record.structure.read!.regions} hovered={null} onHover={() => {}} />)
    const boxes = screen.getAllByTestId('region-box')
    const byId = Object.fromEntries(boxes.map((b) => [b.getAttribute('data-region'), b]))
    expect(byId.r1.style.left).toBe('0%')
    expect(byId.r1.style.width).toBe('100%')
    expect(byId.r1.style.height).toBe('8%')
    expect(byId.r2.style.left).toBe('6.67%')
    expect(byId.r2.style.top).toBe('45.56%')
    expect(within(byId.r2).getByText('button')).toBeTruthy()
    expect(within(byId.r1).getByText('header')).toBeTruthy()
  })

  it('highlights the hovered box and reports hovering', () => {
    const record = readRecord()
    const onHover = vi.fn()
    render(<RegionOverlay regions={record.structure.read!.regions} hovered="r2" onHover={onHover} />)
    const boxes = screen.getAllByTestId('region-box')
    expect(boxes.find((b) => b.getAttribute('data-region') === 'r2')!.className).toContain('ex-box-on')
    expect(boxes.find((b) => b.getAttribute('data-region') === 'r1')!.className).not.toContain('ex-box-on')
    fireEvent.mouseEnter(boxes[0])
    expect(onHover).toHaveBeenCalledWith(boxes[0].getAttribute('data-region'))
    fireEvent.mouseLeave(boxes[0])
    expect(onHover).toHaveBeenLastCalledWith(null)
  })
})

describe('ReadSection', () => {
  it('asks first: nothing is requested until the person presses Read in the confirm', async () => {
    const unread = { ...readRecord(), structure: { ...readRecord().structure, read: null } }
    const onRead = vi.fn(async () => {})
    render(<ReadSection record={unread} onRead={onRead} />)
    expect(screen.queryByText(CONFIRM_LINE)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Read with Claude' }))
    expect(screen.getByText(CONFIRM_LINE)).toBeTruthy()
    expect(CONFIRM_LINE).toBe('This sends the image to Claude through the Claude CLI and uses your Claude usage.')
    expect(onRead).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRead).not.toHaveBeenCalled()
    expect(screen.queryByText(CONFIRM_LINE)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Read with Claude' }))
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))
    expect(onRead).toHaveBeenCalledWith(false)
  })

  it('reading again asks too, and sends again', async () => {
    const onRead = vi.fn(async () => {})
    render(<ReadSection record={readRecord()} onRead={onRead} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }))
    expect(onRead).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(true))
  })

  it('shows pending agent requests above the button, as plain text', () => {
    const record = { ...readRecord(), structure: { ...readRecord().structure, read: null },
      read_requests: [{ actor: 'agent' as const, at: 't', reason: 'Compare <b>headers</b>' }] }
    render(<ReadSection record={record} onRead={async () => {}} />)
    const line = screen.getByText(/An agent asked for a reading:/)
    expect(line.textContent).toBe('An agent asked for a reading: Compare <b>headers</b>')
    expect(line.querySelector('b')).toBeNull()
    expect(line.compareDocumentPosition(screen.getByRole('button', { name: 'Read with Claude' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says fake reader beside the model name only for the fake model', () => {
    const { unmount } = render(<ReadSection record={readRecord('fake-reader')} onRead={async () => {}} />)
    expect(screen.getByText('fake-reader')).toBeTruthy()
    expect(document.querySelector('[data-origin="fake reader"]')).not.toBeNull()
    unmount()
    render(<ReadSection record={readRecord()} onRead={async () => {}} />)
    expect(document.querySelector('[data-origin="fake reader"]')).toBeNull()
    expect(document.querySelector('[data-origin="Claude"]')).not.toBeNull()
  })
})

describe('sections', () => {
  const props = (record = readRecord(), onCorrect = vi.fn()) => ({
    record, view: applied(record), hovered: null as string | null, onHover: vi.fn(), onCorrect,
  })

  it('saves a role change as a correction on that region', () => {
    const onCorrect = vi.fn()
    render(<RegionsSection {...props(readRecord(), onCorrect)} />)
    fireEvent.change(screen.getByLabelText('Role of r2'), { target: { value: 'control' } })
    expect(onCorrect).toHaveBeenCalledWith('structure.read.regions.r2.role', 'control')
  })

  it('saves a label, a text run and a statement only when they changed', () => {
    const onCorrect = vi.fn()
    render(
      <>
        <RegionsSection {...props(readRecord(), onCorrect)} />
        <TextSection {...props(readRecord(), onCorrect)} />
        <ShowsSection {...props(readRecord(), onCorrect)} />
      </>,
    )
    const label = screen.getByLabelText('Label of r1')
    fireEvent.change(label, { target: { value: 'Top bar' } })
    fireEvent.blur(label)
    expect(onCorrect).not.toHaveBeenCalled()
    fireEvent.change(label, { target: { value: 'Navigation bar' } })
    fireEvent.blur(label)
    expect(onCorrect).toHaveBeenLastCalledWith('structure.read.regions.r1.label', 'Navigation bar')
    const words = screen.getByLabelText('Words of t1')
    fireEvent.change(words, { target: { value: 'Begin' } })
    fireEvent.blur(words)
    expect(onCorrect).toHaveBeenLastCalledWith('structure.read.text.t1.content', 'Begin')
    fireEvent.change(screen.getByLabelText('Weight of t1'), { target: { value: 'bold' } })
    expect(onCorrect).toHaveBeenLastCalledWith('structure.read.text.t1.weight', 'bold')
    const statement = screen.getByLabelText('Statement s1')
    fireEvent.change(statement, { target: { value: 'Two accents.' } })
    fireEvent.blur(statement)
    expect(onCorrect).toHaveBeenLastCalledWith('shows.s1.statement', 'Two accents.')
  })

  it('shows sizes and spacing as approximate with an estimate tag', () => {
    render(
      <>
        <TextSection {...props()} />
        <SpacingSection {...props()} />
      </>,
    )
    expect(screen.getByTestId('text-size').textContent).toBe('≈ 14 px')
    expect(screen.getAllByText('estimate').length).toBe(3)
    expect(screen.getByText('≈ 96 px')).toBeTruthy()
    expect(screen.getByText('≈ 40 px')).toBeTruthy()
    expect(screen.getByText(/338 px between the boxes/)).toBeTruthy()
  })

  it('marks corrected values with you and an agent’s with agent', () => {
    const corrections: Correction[] = [
      { path: 'structure.read.regions.r1.role', op: 'set', value: 'navigation', actor: 'person', at: 't' },
      { path: 'structure.read.regions.r2.label', op: 'set', value: 'Go', actor: 'agent', at: 't' },
    ]
    render(<RegionsSection {...props(readRecord('claude-opus-5-5', corrections))} />)
    const rows = screen.getAllByTestId('region-row')
    expect(rows[0].querySelector('[data-origin]')!.getAttribute('data-origin')).toBe('you')
    expect(rows[1].querySelector('[data-origin]')!.getAttribute('data-origin')).toBe('agent')
    expect((screen.getByLabelText('Role of r1') as HTMLSelectElement).value).toBe('navigation')
  })

  it('hovering a row or an evidence chip reports the id to highlight', () => {
    const p = props()
    render(
      <>
        <RegionsSection {...p} />
        <ShowsSection {...p} />
      </>,
    )
    fireEvent.mouseEnter(screen.getAllByTestId('region-row')[1])
    expect(p.onHover).toHaveBeenLastCalledWith('r2')
    const chips = screen.getAllByRole('button').filter((b) => b.getAttribute('data-evidence'))
    expect(chips.map((c) => c.getAttribute('data-evidence'))).toEqual(['P1', 'r2'])
    fireEvent.mouseEnter(chips[0])
    expect(p.onHover).toHaveBeenLastCalledWith('P1')
  })

  it('draws each axis from the middle', () => {
    expect(axisFill(0)).toEqual({ left: '50%', width: '0%' })
    expect(axisFill(1)).toEqual({ left: '50%', width: '50%' })
    expect(axisFill(-0.5)).toEqual({ left: '25%', width: '25%' })
    expect(axisFill(-3)).toEqual({ left: '0%', width: '50%' })
    render(<ReadingSection {...props()} />)
    expect(screen.getAllByTestId('axis-fill').map((el) => (el as HTMLElement).style.width)).toEqual(['25%', '50%'])
  })
})

describe('api read and correct', () => {
  it('sends the token, the folder and again for a read, and the corrections for a correction', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ record: {}, effective: {} }), { status: 200 }))
    const api = createApi('tok', fetchFn)
    await api.read('ex_0123456789abcdef', '/f', true)
    await api.correct('ex_0123456789abcdef', '/f', [{ path: 'brand', op: 'set', value: 'a' }])
    const [read, correct] = fetchFn.mock.calls
    expect(String(read[0])).toBe('/api/records/ex_0123456789abcdef/read')
    expect(String(correct[0])).toBe('/api/records/ex_0123456789abcdef/corrections')
    for (const call of [read, correct]) {
      const init = call[1] as RequestInit
      expect(init.method).toBe('POST')
      expect(new Headers(init.headers).get(TOKEN_HEADER)).toBe('tok')
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    }
    expect(JSON.parse((read[1] as RequestInit).body as string)).toEqual({ folder: '/f', again: true })
    expect(JSON.parse((correct[1] as RequestInit).body as string)).toEqual({
      folder: '/f', corrections: [{ path: 'brand', op: 'set', value: 'a' }],
    })
  })
})
