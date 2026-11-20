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

export function EstimateTag() {
  return <span className="ex-origin ex-estimate" title="The model’s estimate, not a measurement">estimate</span>
}
