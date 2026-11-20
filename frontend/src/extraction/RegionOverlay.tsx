import { boxPosition, drawOrder, words } from './read'
import type { Region } from './types'

/** One 1px outline per region over the rendering, each with its role. `hovered` is a region id or a palette id. */
export function RegionOverlay({ regions, hovered, onHover }: {
  regions: Record<string, Region>
  hovered: string | null
  onHover: (id: string | null) => void
}) {
  const drawn = drawOrder(regions)
  return (
    <div className="ex-overlay" aria-hidden="true">
      {drawn.map(([id, region], i) => (
        <div
          key={id}
          className={hovered === id ? 'ex-box ex-box-on' : 'ex-box'}
          data-testid="region-box"
          data-region={id}
          style={{ ...boxPosition(region.box), animationDelay: `${i * 30}ms` }}
          onMouseEnter={() => onHover(id)}
          onMouseLeave={() => onHover(null)}
        >
          <span className="ex-box-role">{words(region.role)}</span>
        </div>
      ))}
    </div>
  )
}
