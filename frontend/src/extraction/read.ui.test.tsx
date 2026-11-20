import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createApi, TOKEN_HEADER } from './api'
import { CONFIRM_LINE, ReadSection } from './ReadSection'
import { MeasuredLines } from './RecordView'
import { RegionOverlay } from './RegionOverlay'
import { ReadingSection, RegionsSection, ShowsSection, SpacingSection, TextSection } from './Sections'
import { axisFill, ROLE_LABELS, valueLabel } from './read'
import { applied, readRecord } from './testRecord'
import type { Correction } from './types'

describe('RegionOverlay', () => {
  const overlay = (hovered: string | null, selected: string | null, handlers: { onHover?: (id: string | null) => void; onSelect?: (id: string) => void } = {}) => {
    const record = readRecord()
    return render(
      <RegionOverlay
        regions={record.structure.read!.regions}
        hovered={hovered}
        selected={selected}
        onHover={handlers.onHover ?? (() => {})}
        onSelect={handlers.onSelect ?? (() => {})}
      />,
    )
  }
  const box = (id: string) => screen.getAllByTestId('region-box').find((b) => b.getAttribute('data-region') === id)!

  it('positions each box by its fractions', () => {
    overlay(null, null)
    expect(box('r1').style.left).toBe('0%')
    expect(box('r1').style.width).toBe('100%')
    expect(box('r1').style.height).toBe('8%')
    expect(box('r2').style.left).toBe('6.67%')
    expect(box('r2').style.top).toBe('45.56%')
  })

  it('shows a role label only on a hovered, focused or selected box', () => {
    const { unmount } = overlay(null, null)
    expect(screen.queryByText('Button')).toBeNull()
    expect(screen.queryByText('Header')).toBeNull()
    unmount()
    const hovered = overlay('r2', null)
    expect(within(box('r2')).getByText('Button')).toBeTruthy()
    expect(screen.queryByText('Header')).toBeNull()
    hovered.unmount()
    overlay(null, 'r1')
    expect(within(box('r1')).getByText('Header')).toBeTruthy()
    expect(box('r1').className).toContain('ex-box-selected')
    expect(screen.queryByText('Button')).toBeNull()
  })

  it('reports hovering and a click to select', () => {
    const onHover = vi.fn()
    const onSelect = vi.fn()
    overlay(null, null, { onHover, onSelect })
    fireEvent.mouseEnter(box('r1'))
    expect(onHover).toHaveBeenCalledWith('r1')
    fireEvent.mouseLeave(box('r1'))
    expect(onHover).toHaveBeenLastCalledWith(null)
    fireEvent.click(box('r2'))
    expect(onSelect).toHaveBeenCalledWith('r2')
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
    record, view: applied(record), hovered: null as string | null, selected: null as string | null,
    onHover: vi.fn(), onSelect: vi.fn(), onCorrect,
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

  it('shows sizes and spacing as approximate, with estimated in the accessible name and no pill', () => {
    render(
      <>
        <TextSection {...props()} />
        <SpacingSection {...props()} />
      </>,
    )
    expect(screen.getByTestId('text-size').textContent).toBe('≈ 14 px')
    expect(screen.queryByText('estimate')).toBeNull()
    expect(screen.getByLabelText('estimated 14 pixels').textContent).toBe('≈ 14 px')
    expect(screen.getByLabelText('estimated 96 pixels').textContent).toBe('≈ 96 px')
    expect(screen.getByLabelText('estimated 40 pixels').textContent).toBe('≈ 40 px')
    expect(screen.getByText('· measured 338 px')).toBeTruthy()
  })

  it('prints one number for a gap when the estimate and the measured gap agree', () => {
    const record = readRecord()
    record.structure.measured.region_gaps = [{ between: ['r1', 'r2'], axis: 'y', px: 40, origin: 'code' }]
    render(<SpacingSection {...props(record)} />)
    const row = screen.getByTestId('gap-row')
    expect(within(row).getByLabelText('40 pixels, estimated and measured').textContent).toBe('40 px')
    expect(row.textContent).not.toContain('measured 40')
    expect(row.textContent).not.toContain('≈')
  })

  it('reads the stored words through the app labels', () => {
    render(<ReadingSection {...props()} />)
    for (const label of ['Geometric sans', 'Asymmetric', 'UI', 'Airy']) expect(screen.getByText(label)).toBeTruthy()
    for (const end of ['Quiet', 'Loud']) expect(screen.getAllByText(end).length).toBeGreaterThan(0)
    expect(screen.queryByText('ui')).toBeNull()
  })

  it('labels the role and weight choices, never the stored words', () => {
    render(
      <>
        <RegionsSection {...props()} />
        <TextSection {...props()} />
      </>,
    )
    const roles = within(screen.getByLabelText('Role of r1')).getAllByRole('option').map((o) => o.textContent)
    expect(roles).toContain('Header')
    expect(roles).toContain('Text block')
    expect(roles.every((name) => /^[A-Z]/.test(name ?? ''))).toBe(true)
    const weights = within(screen.getByLabelText('Weight of t1')).getAllByRole('option').map((o) => o.textContent)
    expect(weights).toEqual(['Light', 'Regular', 'Medium', 'Bold'])
    expect(valueLabel(ROLE_LABELS, 'a_new_role')).toBe('A new role')
  })

  it('wraps a region label and a statement in a field that grows', () => {
    render(
      <>
        <RegionsSection {...props()} />
        <ShowsSection {...props()} />
      </>,
    )
    for (const name of ['Label of r1', 'Statement s1']) {
      const field = screen.getByLabelText(name)
      expect(field.tagName).toBe('TEXTAREA')
      expect(field.getAttribute('rows')).toBe('1')
      expect(field.hasAttribute('title')).toBe(false)
    }
  })

  it('puts one origin on each section label and none on uncorrected rows', () => {
    const p = props()
    render(
      <>
        <RegionsSection {...p} />
        <TextSection {...p} />
        <SpacingSection {...p} />
        <ReadingSection {...p} />
        <ShowsSection {...p} />
      </>,
    )
    for (const title of ['Regions', 'Text', 'Spacing', 'Reading', 'Shows']) {
      expect(screen.getByRole('heading', { name: `${title} · Claude` })).toBeTruthy()
    }
    expect(document.querySelectorAll('[data-origin]').length).toBe(0)
  })

  it('names the fake reader on the section labels', () => {
    const p = props(readRecord('fake-reader'))
    render(<RegionsSection {...p} />)
    expect(screen.getByRole('heading', { name: 'Regions · fake reader' })).toBeTruthy()
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

  it('keeps a show’s own origin when a person or an agent added it', () => {
    const record = readRecord()
    record.shows.s2 = { statement: 'Mine', evidence: ['P0'], origin: 'person', status: 'proposal', decision_ref: null, order: 1 }
    render(<ShowsSection {...props(record)} />)
    const rows = screen.getAllByTestId('show-row')
    expect(rows[0].querySelector('[data-origin]')).toBeNull()
    expect(rows[1].querySelector('[data-origin]')!.getAttribute('data-origin')).toBe('you')
  })

  it('shows the whole of a long words field in a field that wraps and grows', () => {
    const record = readRecord()
    record.structure.read!.text.t1.content = 'A long line of words that will not fit on one line of the side panel'
    render(<TextSection {...props(record)} />)
    const field = screen.getByLabelText('Words of t1') as HTMLTextAreaElement
    expect(field.tagName).toBe('TEXTAREA')
    expect(field.rows).toBe(1)
    expect(field.value).toBe(record.structure.read!.text.t1.content)
  })

  it('fits a growing field again when its width changes, border included', () => {
    const watchers: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { watchers.push(callback) }
      observe() {}
      disconnect() {}
    })
    // The words need 40px at the first width and 60px once the field narrows; the border adds 2px.
    let width = 200
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width),
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => (width === 200 ? 40 : 60)),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => 26),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 24),
    ]
    try {
      render(<RegionsSection {...props()} />)
      const field = screen.getByLabelText('Label of r1') as HTMLTextAreaElement
      expect(field.style.height).toBe('42px')
      width = 150
      act(() => watchers.forEach((run) => run()))
      expect(field.style.height).toBe('62px')
    } finally {
      spies.forEach((spy) => spy.mockRestore())
      vi.unstubAllGlobals()
    }
  })

  it('selects a region from its id button or its row, and not from a click in a field', () => {
    const p = props()
    render(<RegionsSection {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select r2' }))
    expect(p.onSelect).toHaveBeenLastCalledWith('r2')
    fireEvent.click(screen.getAllByTestId('region-row')[0])
    expect(p.onSelect).toHaveBeenLastCalledWith('r1')
    p.onSelect.mockClear()
    fireEvent.click(screen.getByLabelText('Label of r1'))
    fireEvent.click(screen.getByLabelText('Role of r1'))
    expect(p.onSelect).not.toHaveBeenCalled()
  })

  it('shows a row’s region as focused when a field in it takes focus', () => {
    const p = props()
    render(<RegionsSection {...p} />)
    fireEvent.focus(screen.getByLabelText('Label of r2'))
    expect(p.onHover).toHaveBeenLastCalledWith('r2')
    fireEvent.blur(screen.getByLabelText('Label of r2'))
    expect(p.onHover).toHaveBeenLastCalledWith(null)
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

describe('measured lines', () => {
  const measured = readRecord().structure.measured

  it('reads a record with units on one 0-100 scale', () => {
    const units = { value_range: 'L* 0-100', lightness: 'L* 0-100', saturation: 'HSV saturation 0-100' }
    render(<dl><MeasuredLines measured={{ ...measured, value_range: { low: 11, high: 99 }, lightness: 72.6, saturation: 15.2, units }} /></dl>)
    expect(screen.getByText('Lightness spread').nextSibling!.textContent).toBe('11 to 99')
    expect(screen.getByText('Mean lightness').nextSibling!.textContent).toBe('73')
    expect(screen.getByText('Saturation').nextSibling!.textContent).toBe('15')
    expect(document.body.textContent).not.toContain('of 255')
  })

  it('shows an older record, saved without units, as of 255', () => {
    render(<dl><MeasuredLines measured={{ ...measured, lightness: 200, saturation: 20 }} /></dl>)
    expect(screen.getByText('Mean lightness').nextSibling!.textContent).toBe('200 of 255')
    expect(screen.getByText('Saturation').nextSibling!.textContent).toBe('20 of 255')
    expect(screen.getByText('Lightness spread').nextSibling!.textContent).toBe('10 to 95 of 100')
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
