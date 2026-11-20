import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, type Api, type RecordDetail } from './api'
import type { Opened } from './detail'
import { cameIn, readTime, statusLabel } from './format'
import { SectionLabel } from './Origin'
import { segmentWidths, sharePercent } from './palette'
import { FAKE_MODEL, usableRegions } from './read'
import { ReadSection } from './ReadSection'
import { RegionOverlay } from './RegionOverlay'
import { useRendering } from './rendering'
import { ReadingSection, RegionsSection, ShowsSection, SpacingSection, TextSection } from './Sections'
import type { ExtractionRecord, PaletteEntry } from './types'

function Line({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="ex-line">
      <dt>{name}</dt>
      <dd>
        <span className="ex-value">{children}</span>
      </dd>
    </div>
  )
}

export function PaletteBar({ palette }: { palette: readonly PaletteEntry[] }) {
  const widths = useMemo(() => segmentWidths(palette), [palette])
  return (
    <div className="ex-bar" role="img" aria-label="The palette, each color as wide as its share of the image">
      {palette.map((entry, i) => (
        <span
          key={entry.index}
          className={entry.is_accent ? 'ex-seg ex-seg-accent' : 'ex-seg'}
          data-testid="palette-segment"
          style={{ width: `${widths[i]}%`, backgroundColor: entry.hex, animationDelay: `${i * 40}ms` }}
        />
      ))}
    </div>
  )
}

function Colors({ palette, hovered }: { palette: readonly PaletteEntry[]; hovered: string | null }) {
  if (palette.length === 0) return <p className="ex-quiet">No colors were found.</p>
  return (
    <>
      <PaletteBar palette={palette} />
      <ul className="ex-colors">
        {palette.map((entry) => (
          <li key={entry.index} className={hovered === `P${entry.index}` ? 'ex-color-on' : undefined} data-palette={`P${entry.index}`}>
            <span className="ex-swatch" style={{ backgroundColor: entry.hex }} />
            <span className="ex-hex">{entry.hex}</span>
            <span className="ex-share">{sharePercent(entry.share)}</span>
            <span className="ex-accent-tag">{entry.is_accent ? 'accent' : ''}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/** A mean on its record's scale: 0-100 with `units`, "of 255" on a record saved before units existed. */
const mean = (value: number | null, legacy: boolean) =>
  value === null ? 'Not measured' : `${Math.round(value)}${legacy ? ' of 255' : ''}`

export function MeasuredLines({ measured }: { measured: ExtractionRecord['structure']['measured'] }) {
  const legacy = !measured.units
  const range = measured.value_range
  const spread = range ? `${Math.round(range.low)} to ${Math.round(range.high)}${legacy ? ' of 100' : ''}` : 'Not measured'
  return (
    <>
      <Line name="Lightness spread">{spread}</Line>
      <Line name="Mean lightness">{mean(measured.lightness, legacy)}</Line>
      <Line name="Saturation">{mean(measured.saturation, legacy)}</Line>
    </>
  )
}

const sentence = (error: unknown) => (error instanceof ApiError ? error.message : 'That didn’t work. Try again.')

export function RecordView({ api, folder, detail, onClose, onChange, onNotice }: {
  api: Api
  folder: string
  detail: RecordDetail
  onClose: () => void
  onChange: (next: RecordDetail, from: Opened) => void
  onNotice: (message: string | null) => void
}) {
  const { record, effective: view } = detail
  const url = useRendering(api, folder, record.id)
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const { measured } = view.structure
  const read = view.structure.read

  const correct = useCallback((path: string, value: unknown) => {
    onNotice(null)
    const from = { folder, id: record.id } // the record this was asked for, not whichever is open when it answers
    api.correct(record.id, folder, [{ path, op: 'set', value }]).then((next) => onChange(next, from), (error: unknown) => onNotice(sentence(error)))
  }, [api, folder, onChange, onNotice, record.id])

  const startRead = useCallback(async (again: boolean) => {
    onNotice(null)
    const from = { folder, id: record.id }
    try {
      onChange(await api.read(record.id, folder, again), from)
    } catch (error) {
      onNotice(sentence(error))
    }
  }, [api, folder, onChange, onNotice, record.id])

  // Clicking the selected box or row again clears it; Escape clears it too.
  const select = useCallback((id: string) => setSelected((now) => (now === id ? null : id)), [])
  useEffect(() => {
    if (selected === null) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selected])

  const sectionProps = {
    record: record as ExtractionRecord, view, hovered, selected, onHover: setHovered, onSelect: select, onCorrect: correct,
  }

  return (
    <div className="ex-record">
      <div className="ex-stage">
        {url ? (
          <div className="ex-frame" style={{ '--ex-ratio': String(record.rendering.width / record.rendering.height) } as React.CSSProperties}>
            <img className="ex-rendering" src={url} alt={record.source.name ?? 'The measured image'} />
            {read ? <RegionOverlay key={read.read_at} regions={usableRegions(read.regions)} hovered={hovered} selected={selected} onHover={setHovered} onSelect={select} /> : null}
          </div>
        ) : null}
      </div>
      <aside className="ex-side">
        <div className="ex-side-head">
          <span className="ex-status">{statusLabel(record.status)}</span>
          {read?.model === FAKE_MODEL ? <span className="ex-status ex-status-fake">Fake reading</span> : null}
          <button type="button" className="ex-button ex-button-quiet" onClick={onClose}>
            Close
          </button>
        </div>
        <section>
          <SectionLabel title="Colors" tag="code" />
          <Colors palette={measured.palette} hovered={hovered} />
        </section>
        <section>
          <SectionLabel title="Measured" tag="code" />
          <dl>
            <Line name="Size">{record.rendering.width} × {record.rendering.height} px</Line>
            <Line name="Aspect">{measured.aspect.toFixed(2)}</Line>
            <MeasuredLines measured={measured} />
            <Line name="Perceptual hash"><span className="ex-mono">{record.rendering.phash}</span></Line>
          </dl>
        </section>
        <section>
          <SectionLabel title="Source" tag="code" />
          <dl>
            <Line name="Name">{record.source.name || 'Unnamed'}</Line>
            <Line name="Came in">{cameIn(record.source.kind)}</Line>
            <Line name="Added">{readTime(record.source.read_at)}</Line>
            <Line name="Hash"><span className="ex-mono">{record.rendering.sha256.slice(0, 12)}</span></Line>
          </dl>
        </section>
        <ReadSection key={record.structure.read?.read_at ?? 'unread'} record={record} onRead={startRead} />
        {read ? (
          <>
            <RegionsSection {...sectionProps} />
            <TextSection {...sectionProps} />
            <SpacingSection {...sectionProps} />
            <ReadingSection {...sectionProps} />
            <ShowsSection {...sectionProps} />
          </>
        ) : null}
      </aside>
    </div>
  )
}
