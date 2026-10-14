import type { JevResult } from '../../lib/jev';
import {
  decideMode, isCloseCall, jevRunCost, judgedImages, probabilityRows, requestedAlias, splitLines,
  unit, verdictLabel,
} from '../../lib/jevView';
import '../../styles/jev-result.css';

interface JevResultDetailsProps {
  result: JevResult;
  params: Record<string, unknown>;
}

function summary(result: JevResult, params: Record<string, unknown>): { tone: string; verdict: string; text: string } {
  if (result.kind === 'decide') {
    const verdict = verdictLabel(result.pass, decideMode(result, params), params);
    return { tone: verdict.tone, verdict: verdict.label, text: result.answer };
  }
  if (result.kind === 'pick-best') {
    const close = isCloseCall(result.confidence, params);
    return { tone: close ? 'unsure' : 'pass', verdict: close ? 'Close call' : 'Winner', text: `Candidate ${result.index + 1}` };
  }
  if (result.found === 'false') return { tone: 'none', verdict: 'Not found', text: result.report?.fields.Target ?? '' };
  const tone = result.found === 'true' ? 'pass' : 'unsure';
  const verdict = result.found === 'true' ? 'Found' : 'Unsure';
  if (!result.box) return { tone, verdict, text: '' };
  const { px } = result.box;
  return {
    tone,
    verdict,
    text: `${px.w} × ${px.h} px`,
  };
}

function rowsFor(result: JevResult, params: Record<string, unknown>): Array<{ label: string; value: number; top: boolean }> {
  if (result.kind === 'box') return [];
  const hint = result.kind === 'decide'
    ? splitLines(decideMode(result, params) === 'score' ? params.levels : params.options)
    : undefined;
  const rows = probabilityRows(result, hint);
  const topLabel = result.kind === 'decide' ? result.answer : String(result.index);
  return rows.map((row) => ({
    label: result.kind === 'pick-best' ? `Candidate ${Number(row.label) + 1}` : row.label,
    value: row.value,
    top: row.label === topLabel,
  }));
}

/** The whole Jev result for the Inspector: every probability, then the facts
 * of the run (which model answered, tokens, cost, request id). */
export function JevResultDetails({ result, params }: JevResultDetailsProps) {
  const head = summary(result, params);
  const rows = rowsFor(result, params);
  const report = result.report;
  const alias = requestedAlias(report);
  const cost = jevRunCost(report);
  const confidence = result.kind === 'box'
    ? (result.box ? (result.box.confidence === null ? 'not reported' : String(result.box.confidence)) : null)
    : String(result.confidence);
  const facts: Array<[string, string]> = [];
  if (result.kind === 'box' && report?.fields.Presence) facts.push(['Presence', report.fields.Presence]);
  if (result.kind === 'box' && result.box) {
    const { px, image } = result.box;
    facts.push(['Box', `x ${px.x}, y ${px.y} of ${image.w} × ${image.h}`]);
  }
  if (confidence !== null) facts.push([result.kind === 'box' ? 'Box confidence' : 'Confidence', confidence]);
  if (result.kind === 'decide') facts.push(['Probability', String(result.probability)]);
  if (report?.model) facts.push(['Model', report.model]);
  if (alias) facts.push(['Asked for', alias]);
  if (report) facts.push(['Input tokens', report.inputTokens === null ? 'unknown' : report.inputTokens.toLocaleString('en-US')]);
  if (cost) facts.push(['Cost', `≈ ${cost}`]);
  if (judgedImages(report)) facts.push(['Images', report!.fields.Images]);
  if (report?.fields['Request id']) facts.push(['Request id', report.fields['Request id']]);

  return (
    <div className="inspector__section inspector__section--separated jev-details" data-testid="jev-details">
      <div className="inspector__label">Result</div>
      <div className="jev-details__summary">
        <span className={`jev-result__chip jev-result__chip--${head.tone}`}>
          <span className="jev-result__chip-dot" aria-hidden="true" />
          {head.verdict}
        </span>
        {head.text && <span title={head.text}>{head.text}</span>}
      </div>
      {rows.length > 0 && (
        <table className="jev-details__table" aria-label="Probabilities">
          <thead>
            <tr><th scope="col">{result.kind === 'pick-best' ? 'Candidate' : 'Answer'}</th><th scope="col" aria-label="Share" /><th scope="col">Probability</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className={row.top ? 'jev-details__row--top' : undefined}>
                <td title={row.label}>{row.label}</td>
                <td>
                  <span className="jev-result__bar-track">
                    <span
                      className={`jev-result__bar-fill ${row.top ? `jev-result__fill--${head.tone === 'none' ? 'rest' : head.tone}` : 'jev-result__fill--rest'}`}
                      style={{ ['--jev-value' as string]: unit(row.value) }}
                    />
                  </span>
                </td>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="jev-details__facts">
        {facts.map(([term, value]) => (
          <div key={term} className="jev-details__fact">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {report && report.notes.length > 0 && (
        <ul className="jev-details__notes">
          {report.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}
