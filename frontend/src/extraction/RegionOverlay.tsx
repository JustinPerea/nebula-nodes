import { boxPosition, drawOrder, words } from './read'
import type { Region } from './types'

/**
 * One two-tone 1px outline per region over the rendering. A box carries its role only while it or its row
 * is hovered or focused (`hovered`, a region id or a palette id) and while it is selected. Clicking a box
 * selects it; clicking the selected box clears it.
 */
export function RegionOverlay({ regions, hovered, selected, onHover, onSelect }: {
  regions: Record<string, Region>
  hovered: string | null
  selected: string | null
  onHover: (id: string | null) => void
  onSelect: (id: string) => void
}) {
  const drawn = drawOrder(regions)
  return (
    <div className="ex-overlay" aria-hidden="true">
      {drawn.map(([id, region], i) => {
        const showRole = hovered === id || selected === id
        return (
          <div
            key={id}
            className={selected === id ? 'ex-box ex-box-on ex-box-selected' : showRole ? 'ex-box ex-box-on' : 'ex-box'}
            data-testid="region-box"
            data-region={id}
            style={{ ...boxPosition(region.box), animationDelay: `${i * 30}ms` }}
            onMouseEnter={() => onHover(id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onSelect(id)}
          >
            {showRole ? <span className="ex-box-role">{words(region.role)}</span> : null}
          </div>
        )
      })}
    </div>
  )
}
