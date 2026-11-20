import { useState } from 'react'
import { EstimateTag, Origin } from './Origin'
import { axisFill, inOrder, isPaletteId, modelTag, originAt, ROLES, showOrigin, WEIGHTS, words } from './read'
import type { CodeGap, ExtractionRecord, Region, Show, TextRun } from './types'

export type Correct = (path: string, value: unknown) => void

interface Props {
  /** The record as saved, for who set what. */
  record: ExtractionRecord
  /** The record with corrections applied: what the page shows. */
  view: ExtractionRecord
  hovered: string | null
  onHover: (id: string | null) => void
  onCorrect: Correct
}

function EditableText({ value, label, onCommit }: { value: string; label: string; onCommit: (next: string) => void }) {
  // null: not being edited, so the field shows the saved value (which changes when a correction lands).
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const next = (draft ?? value).trim()
    if (next && next !== value) onCommit(next)
    setDraft(null)
  }
  return (
    <input
      className="ex-input ex-input-small"
      type="text"
      value={draft ?? value}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') setDraft(null)
      }}
    />
  )
}

function Choose({ value, options, label, onPick }: {
  value: string
  options: readonly string[]
  label: string
  onPick: (next: string) => void
}) {
  const all = options.includes(value) ? options : [value, ...options]
  return (
    <select className="ex-select" value={value} aria-label={label} onChange={(event) => onPick(event.target.value)}>
      {all.map((option) => (
        <option key={option} value={option}>
          {words(option)}
        </option>
      ))}
    </select>
  )
}

export function RegionsSection({ record, view, hovered, onHover, onCorrect }: Props) {
  const regions = inOrder(view.structure.read?.regions)
  const base = modelTag(record.structure.read?.model)
  const measures = view.structure.measured.region_measures
  return (
    <section>
      <h2 className="ex-label">Regions</h2>
      <ul className="ex-rows">
        {regions.map(([id, region]: [string, Region]) => {
          const path = `structure.read.regions.${id}`
          const swatch = !Array.isArray(measures) ? measures?.[id]?.palette?.[0]?.hex : undefined
          return (
            <li
              key={id}
              className={hovered === id ? 'ex-row-item2 ex-row-on ex-pop' : 'ex-row-item2 ex-pop'}
              data-testid="region-row"
              onMouseEnter={() => onHover(id)}
              onMouseLeave={() => onHover(null)}
            >
              <span className="ex-id">{id}</span>
              <Choose value={region.role} options={ROLES} label={`Role of ${id}`} onPick={(role) => onCorrect(`${path}.role`, role)} />
              <EditableText value={region.label} label={`Label of ${id}`} onCommit={(label) => onCorrect(`${path}.label`, label)} />
              <Origin tag={originAt(record.corrections, path, base)} />
              {swatch ? <span className="ex-swatch ex-swatch-small" title="Most common color in this box, measured by code" style={{ backgroundColor: swatch }} /> : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function TextSection({ record, view, onCorrect }: Props) {
  const runs = inOrder(view.structure.read?.text)
  const base = modelTag(record.structure.read?.model)
  if (runs.length === 0) return (
    <section>
      <h2 className="ex-label">Text</h2>
      <p className="ex-quiet">No text was found.</p>
    </section>
  )
  return (
    <section>
      <h2 className="ex-label">Text</h2>
      <ul className="ex-rows">
        {runs.map(([id, run]: [string, TextRun]) => {
          const path = `structure.read.text.${id}`
          return (
            <li key={id} className="ex-row-item2 ex-pop" data-testid="text-row">
              <span className="ex-id">{id}</span>
              <EditableText value={run.content} label={`Words of ${id}`} onCommit={(content) => onCorrect(`${path}.content`, content)} />
              <span className="ex-approx" data-testid="text-size">≈ {run.size_px.value} px</span>
              <EstimateTag />
              <Choose value={run.weight} options={WEIGHTS} label={`Weight of ${id}`} onPick={(weight) => onCorrect(`${path}.weight`, weight)} />
              <Origin tag={originAt(record.corrections, path, base)} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function codeGap(gaps: CodeGap[] | undefined, a: string, b: string): CodeGap | undefined {
  return gaps?.find((g) => (g.between[0] === a && g.between[1] === b) || (g.between[0] === b && g.between[1] === a))
}

export function SpacingSection({ record, view }: Props) {
  const spacing = view.structure.read?.spacing
  const base = modelTag(record.structure.read?.model)
  if (!spacing) return null
  const origin = originAt(record.corrections, 'structure.read.spacing', base)
  return (
    <section>
      <h2 className="ex-label">Spacing</h2>
      <ul className="ex-rows">
        <li className="ex-row-item2 ex-pop">
          <span className="ex-grow">Outer margin</span>
          <span className="ex-approx">≈ {spacing.outer_margin_px.value} px</span>
          <EstimateTag />
          <Origin tag={origin} />
        </li>
        {spacing.gaps.map((gap) => {
          const measured = codeGap(view.structure.measured.region_gaps, gap.between[0], gap.between[1])
          return (
            <li key={`${gap.between.join('-')}-${gap.axis}`} className="ex-row-item2 ex-pop" data-testid="gap-row">
              <span className="ex-grow">{gap.between[0]} to {gap.between[1]}, {gap.axis === 'x' ? 'across' : 'down'}</span>
              <span className="ex-approx">≈ {gap.px} px</span>
              <EstimateTag />
              <Origin tag={origin} />
              {measured ? <span className="ex-quiet" title="Measured by code from the model’s boxes">{measured.px} px between the boxes</span> : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const AXIS_LABELS: Record<string, [string, string]> = {
  quiet_loud: ['quiet', 'loud'],
  warm_cold: ['warm', 'cold'],
  geometric_humanist: ['geometric', 'humanist'],
  dense_airy: ['dense', 'airy'],
  polished_raw: ['polished', 'raw'],
}

export function ReadingSection({ record, view }: Props) {
  const one = view.structure.read?.reader_1
  const base = modelTag(record.structure.read?.model)
  if (!one) return null
  const tag = originAt(record.corrections, 'structure.read.reader_1', base)
  const line = (name: string, value: string) => (
    <div className="ex-line">
      <dt>{name}</dt>
      <dd>
        <span className="ex-value">{words(value)}</span>
        <Origin tag={tag} />
      </dd>
    </div>
  )
  return (
    <section>
      <h2 className="ex-label">Reading</h2>
      <p className="ex-summary">{one.summary.value}</p>
      <dl>
        {line('Type style', one.type_style.value)}
        {line('Layout', one.layout.value)}
        {line('Medium', one.medium.value)}
        {line('Spacing', one.spacing_density.value)}
      </dl>
      <ul className="ex-axes">
        {Object.entries(one.axes).map(([name, axis]) => {
          const [low, high] = AXIS_LABELS[name] ?? [name, name]
          return (
            <li key={name} title={axis.why}>
              <span className="ex-axis-end">{low}</span>
              <span className="ex-axis" role="img" aria-label={`${low} to ${high}: ${axis.value}`}>
                <span className="ex-axis-fill" data-testid="axis-fill" style={axisFill(axis.value)} />
              </span>
              <span className="ex-axis-end">{high}</span>
            </li>
          )
        })}
      </ul>
      <ul className="ex-chips">
        {one.keywords.map((word) => (
          <li key={word} className="ex-chip">{words(word)}</li>
        ))}
      </ul>
    </section>
  )
}

export function ShowsSection({ record, view, onHover, onCorrect }: Props) {
  const shows = inOrder(view.shows)
  return (
    <section>
      <h2 className="ex-label">Shows</h2>
      {shows.length === 0 ? <p className="ex-quiet">Nothing is proposed yet.</p> : null}
      <ul className="ex-rows">
        {shows.map(([id, show]: [string, Show]) => (
          <li key={id} className="ex-show ex-pop" data-testid="show-row">
            <div className="ex-show-line">
              <EditableText value={show.statement} label={`Statement ${id}`} onCommit={(next) => onCorrect(`shows.${id}.statement`, next)} />
              <Origin tag={showOrigin(record, id, show.origin)} />
            </div>
            <ul className="ex-chips">
              {show.evidence.map((evidence) => (
                <li key={evidence}>
                  <button
                    type="button"
                    className="ex-chip ex-chip-button"
                    data-evidence={evidence}
                    title={isPaletteId(evidence) ? 'A palette color' : 'A region'}
                    onMouseEnter={() => onHover(evidence)}
                    onMouseLeave={() => onHover(null)}
                    onFocus={() => onHover(evidence)}
                    onBlur={() => onHover(null)}
                  >
                    {evidence}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
