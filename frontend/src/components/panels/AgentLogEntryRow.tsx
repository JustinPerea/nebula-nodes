import type { AgentLogEntry } from '../../store/agentLogStore';

/** One Agent log event row: the log's list, and a thread's opened "3 actions". */
export function AgentLogEntryRow({ entry: e }: { entry: AgentLogEntry }) {
  const line = e.message;
  return (
    <li
      className={`agent-log__entry agent-log__entry--${e.source}${e.tone === 'muted' ? ' agent-log__entry--muted' : ''}`}
      data-source={e.source}
      // The log's source column names the agent, so a line reads whole without
      // it ("Couldn’t run “Writer” because ..."): the row's accessible name
      // starts with the source, as the line used to (GM - Design, PR #212 r2).
      aria-label={`${e.agent?.name ?? e.source}: ${line}`}
      data-agent={e.agent?.id}
      style={e.agent ? { ['--agent-log-source-color' as string]: e.agent.color, ['--agent-log-name-color' as string]: e.agent.ink ?? e.agent.color } : undefined}
    >
      <span className="agent-log__entry-marker" aria-hidden="true" />
      <span className="agent-log__time">
        {new Date(e.ts).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </span>
      <span className="agent-log__source" title={e.agent?.name}>{e.agent?.name ?? e.source}</span>
      <span className="agent-log__msg">{line}</span>
    </li>
  );
}
