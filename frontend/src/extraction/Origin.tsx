import type { OriginTag } from './read'

const TITLES: Record<OriginTag, string> = {
  code: 'Set by code',
  Claude: 'Read by Claude',
  'fake reader': 'Answered by the development reader, not by Claude',
  you: 'Changed by you',
  agent: 'Changed by an agent',
}

export function Origin({ tag }: { tag: OriginTag }) {
  const tone = tag === 'you' ? ' ex-origin-you' : tag === 'agent' ? ' ex-origin-agent' : ''
  return (
    <span className={`ex-origin${tone}`} title={TITLES[tag]} data-origin={tag}>
      {tag}
    </span>
  )
}

/** A row's tag: shown only when it differs from the section's, so a changed row says who changed it. */
export function RowOrigin({ tag, base }: { tag: OriginTag; base: OriginTag }) {
  return tag === base ? null : <Origin tag={tag} />
}

/** A section's label with its one origin: "Regions · Claude". */
export function SectionLabel({ title, tag }: { title: string; tag: OriginTag }) {
  return (
    <h2 className="ex-label">
      {title}{' '}
      <span className="ex-label-origin" data-section-origin={tag} title={TITLES[tag]}>
        · {tag}
      </span>
    </h2>
  )
}
