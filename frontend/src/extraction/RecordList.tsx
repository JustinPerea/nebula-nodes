import type { Api } from './api'
import { statusLabel } from './format'
import { useRendering } from './rendering'
import type { RecordRow } from './types'

function Row({ api, folder, row, selected, arrived, onOpen }: {
  api: Api
  folder: string
  row: RecordRow
  selected: boolean
  arrived: boolean
  onOpen: (id: string) => void
}) {
  const url = useRendering(api, folder, row.id)
  if (row.error) {
    return (
      <li className="ex-row ex-row-broken">
        <span className="ex-thumb" aria-hidden="true" />
        <span className="ex-row-text">
          <span className="ex-row-name">{row.id}</span>
          <span className="ex-row-sub">Can’t be read</span>
        </span>
      </li>
    )
  }
  return (
    <li className={arrived ? 'ex-row-item ex-arrived' : 'ex-row-item'}>
      <button
        type="button"
        className={selected ? 'ex-row ex-selected' : 'ex-row'}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onOpen(row.id)}
      >
        <span className="ex-thumb">{url ? <img src={url} alt="" /> : null}</span>
        <span className="ex-row-text">
          <span className="ex-row-name">{row.name || 'Unnamed image'}</span>
          <span className="ex-row-sub">{statusLabel(row.status ?? 'proposal')}</span>
        </span>
      </button>
    </li>
  )
}

export function RecordList({ api, folder, rows, selectedId, arrivedIds, onOpen }: {
  api: Api
  folder: string
  rows: RecordRow[]
  selectedId: string | null
  arrivedIds: ReadonlySet<string>
  onOpen: (id: string) => void
}) {
  if (rows.length === 0) return <p className="ex-quiet ex-pad">No records in this folder yet.</p>
  return (
    <ul className="ex-list">
      {rows.map((row) => (
        <Row
          key={row.id}
          api={api}
          folder={folder}
          row={row}
          selected={row.id === selectedId}
          arrived={arrivedIds.has(row.id)}
          onOpen={onOpen}
        />
      ))}
    </ul>
  )
}
