import { useState } from 'react';
import { parseJevNumber, type JevBoxResult, type JevDecideResult, type JevPickBestResult, type JevResult } from '../../lib/jev';
import { backendAssetUrlSync } from '../../lib/backend';
import {
  askedQuestion, decideMode, formatJevPercent, isCloseCall, judgedImages, matchingCandidates, numberParam,
  probabilityRows, splitLines, unit, verdictLabel, type JevDecideMode, type JevVerdictLabel,
} from '../../lib/jevView';
import '../../styles/jev-result.css';

/** Values wired into the node, for results that point back at them. */
export interface JevResultInputs {
  /** Pick Best: the candidates in the order the engine sent them. */
  candidates?: string[];
  /** Box: the image that was searched. */
  image?: string | null;
  /** Decide: true when On Pass or On Fail is wired, so the card says which
   * branch the verdict took. */
  gated?: boolean;
}

interface JevResultViewProps {
  result: JevResult;
  params: Record<string, unknown>;
  inputs?: JevResultInputs;
}

type Tone = JevVerdictLabel['tone'] | 'none';

// Choice rows past this many collapse into "+N more"; the Inspector has them all.
const CHOICE_ROWS = 4;
// Pick Best thumbnails on the card; the rest are counted.
const CANDIDATE_THUMBS = 8;

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`jev-result__chip jev-result__chip--${tone}`}>
      <span className="jev-result__chip-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function ExperimentalBadge() {
  return (
    <span className="jev-result__badge" title="TypeSafe marks image input as experimental: results can change between releases.">
      Experimental
    </span>
  );
}

function Footer({ confidence, model, label = 'Confidence' }: { confidence: string; model: string | null; label?: string }) {
  return (
    <div className="jev-result__footer">
      <span>{label} <span className="jev-result__figure">{confidence}</span></span>
      {model && <span className="jev-result__model">{model}</span>}
    </div>
  );
}

function Question({ text }: { text: string | null }) {
  return text ? <p className="jev-result__question" title={text}>{text}</p> : null;
}

function YesNoMeter({ result, threshold, tone }: { result: JevDecideResult; threshold: number; tone: Tone }) {
  const yes = unit(result.probabilities.yes ?? result.probability);
  return (
    <div className="jev-result__meter-block">
      <div
        className="jev-result__meter"
        role="meter"
        aria-label="Probability of yes"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={yes}
        aria-valuetext={`${formatJevPercent(yes)} yes`}
      >
        <span className={`jev-result__meter-fill jev-result__fill--${tone}`} style={{ ['--jev-value' as string]: yes }} />
        <span
          className="jev-result__threshold"
          style={{ left: `${unit(threshold) * 100}%` }}
          title={`Passes at ${formatJevPercent(threshold)} yes or more`}
        />
      </div>
      <div className="jev-result__scale">
        <span>No <span className="jev-result__figure">{formatJevPercent(1 - yes)}</span></span>
        <span>Yes <span className="jev-result__figure">{formatJevPercent(yes)}</span></span>
      </div>
    </div>
  );
}

function ChoiceBars({ result, options, tone }: { result: JevDecideResult; options: string[]; tone: Tone }) {
  const rows = probabilityRows(result, options).sort((a, b) => b.value - a.value);
  const shown = rows.slice(0, CHOICE_ROWS);
  const hidden = rows.length - shown.length;
  return (
    <div className="jev-result__bars" role="list" aria-label="Probability of each option">
      {shown.map((row, index) => {
        const winner = row.label === result.answer;
        return (
          <div
            key={row.label}
            role="listitem"
            className={`jev-result__bar-row${winner ? ' jev-result__bar-row--winner' : ''}`}
            style={{ ['--jev-delay' as string]: `${index * 40}ms` }}
          >
            <span className="jev-result__bar-label" title={row.label}>{row.label}</span>
            <span className="jev-result__bar-track">
              <span
                className={`jev-result__bar-fill ${winner ? `jev-result__fill--${tone}` : 'jev-result__fill--rest'}`}
                style={{ ['--jev-value' as string]: unit(row.value) }}
              />
            </span>
            <span className="jev-result__figure">{formatJevPercent(row.value)}</span>
          </div>
        );
      })}
      {hidden > 0 && <span className="jev-result__more">+{hidden} more</span>}
    </div>
  );
}

function ScoreLevels({ result, levels, tone }: { result: JevDecideResult; levels: string[]; tone: Tone }) {
  const rows = probabilityRows(result, levels);
  const position = unit(result.probability);
  return (
    <div className="jev-result__meter-block">
      <div
        className="jev-result__levels"
        role="meter"
        aria-label="Score"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={position}
        aria-valuetext={`${result.answer}, ${formatJevPercent(position)} of the scale`}
        style={{ ['--jev-level-count' as string]: rows.length }}
      >
        {rows.map((row, index) => (
          <span
            key={row.label}
            className={`jev-result__level${row.label === result.answer ? ` jev-result__level--answer jev-result__fill--${tone}` : ''}`}
            title={`${row.label}: ${formatJevPercent(row.value)}`}
            style={{ ['--jev-weight' as string]: unit(row.value), ['--jev-delay' as string]: `${index * 30}ms` }}
          />
        ))}
        <span className="jev-result__notch" style={{ left: `${position * 100}%` }} aria-hidden="true" />
      </div>
      {rows.length > 0 && (
        <div className="jev-result__scale">
          <span title={rows[0].label}>{rows[0].label}</span>
          <span title={rows[rows.length - 1].label}>{rows[rows.length - 1].label}</span>
        </div>
      )}
    </div>
  );
}

/** How likely the shown answer is: "no" at 7% yes reads 93%, and a score
 * shows its most likely level's share rather than the normalized score. */
function answerProbability(result: JevDecideResult): number {
  return result.probabilities[result.answer] ?? result.probability;
}

function displayAnswer(answer: string, mode: JevDecideMode): string {
  if (mode !== 'yes_no') return answer;
  return answer.charAt(0).toUpperCase() + answer.slice(1);
}

// The gate port a Decide verdict went out on, in the definition's port names.
function branchText(branch: JevDecideResult['branch']): string {
  if (branch === 'pass') return 'Sent on On Pass';
  if (branch === 'fail') return 'Sent on On Fail';
  return 'Held back on both branches';
}

function JevDecideView({ result, params, gated }: { result: JevDecideResult; params: Record<string, unknown>; gated: boolean }) {
  const mode = decideMode(result, params);
  const verdict = verdictLabel(result.pass, mode, params);
  const question = askedQuestion(result.report, params, 'question', 'Question');
  return (
    <div className={`jev-result jev-result--decide jev-result--${verdict.tone}`} data-testid="jev-result" data-kind="decide" data-mode={mode}>
      <div className="jev-result__top">
        <Chip tone={verdict.tone}>{verdict.label}</Chip>
        {judgedImages(result.report) && <ExperimentalBadge />}
      </div>
      <Question text={question} />
      <div className="jev-result__headline">
        <span className="jev-result__answer" title={result.answer}>{displayAnswer(result.answer, mode)}</span>
        <span className="jev-result__headline-figure">{formatJevPercent(answerProbability(result))}</span>
      </div>
      {mode === 'yes_no' && <YesNoMeter result={result} threshold={numberParam(params, 'threshold', 0.5)} tone={verdict.tone} />}
      {mode === 'choice' && <ChoiceBars result={result} options={splitLines(params.options)} tone={verdict.tone} />}
      {mode === 'score' && <ScoreLevels result={result} levels={splitLines(params.levels)} tone={verdict.tone} />}
      {gated && (
        <p className={`jev-result__branch jev-result__branch--${result.branch ?? 'none'}`} data-testid="jev-branch">
          <span aria-hidden="true">→</span> {branchText(result.branch)}
        </p>
      )}
      <Footer confidence={formatJevPercent(result.confidence)} model={result.report?.model ?? null} />
    </div>
  );
}

function JevPickBestView({ result, params, candidates }: {
  result: JevPickBestResult; params: Record<string, unknown>; candidates: string[] | undefined;
}) {
  const close = isCloseCall(result.confidence, params);
  const rows = probabilityRows(result);
  const thumbs = matchingCandidates(candidates ?? [], result);
  const question = askedQuestion(result.report, params, 'question', 'Question');
  const shown = rows.slice(0, CANDIDATE_THUMBS);
  const hidden = rows.length - shown.length;
  const winnerProbability = result.probabilities[String(result.index)] ?? 0;
  return (
    <div className={`jev-result jev-result--pick-best${close ? ' jev-result--close' : ''}`} data-testid="jev-result" data-kind="pick-best">
      <div className="jev-result__top">
        <Chip tone={close ? 'unsure' : 'pass'}>{close ? 'Close call' : `Best of ${rows.length}`}</Chip>
        {judgedImages(result.report) && <ExperimentalBadge />}
      </div>
      <Question text={question} />
      <div className="jev-result__hero">
        <img src={backendAssetUrlSync(result.winner)} alt={`Winner, candidate ${result.index + 1}`} draggable={false} />
        <span className="jev-result__hero-label">
          #{result.index + 1} <span className="jev-result__figure">{formatJevPercent(winnerProbability)}</span>
        </span>
      </div>
      <div
        className={`jev-result__candidates${thumbs ? '' : ' jev-result__candidates--bars'}`}
        role="list"
        aria-label="Probability of each candidate"
        style={{ ['--jev-columns' as string]: Math.min(4, Math.max(2, shown.length)) }}
      >
        {shown.map((row, position) => {
          const index = Number(row.label);
          const winner = index === result.index;
          const src = thumbs?.[index];
          return (
            <div
              key={row.label}
              role="listitem"
              className={`jev-result__candidate${winner ? ' jev-result__candidate--winner' : ''}`}
              aria-label={`Candidate ${index + 1}: ${formatJevPercent(row.value)}${winner ? ', winner' : ''}`}
              style={{ ['--jev-delay' as string]: `${position * 40}ms` }}
            >
              {src
                ? <img className="jev-result__thumb" src={backendAssetUrlSync(src)} alt="" draggable={false} />
                : <span className="jev-result__thumb jev-result__thumb--empty">#{index + 1}</span>}
              <span className="jev-result__bar-track">
                <span
                  className={`jev-result__bar-fill ${winner ? `jev-result__fill--${close ? 'unsure' : 'pass'}` : 'jev-result__fill--rest'}`}
                  style={{ ['--jev-value' as string]: unit(row.value) }}
                />
              </span>
              <span className="jev-result__figure">{formatJevPercent(row.value)}</span>
            </div>
          );
        })}
        {hidden > 0 && <span className="jev-result__more">+{hidden} more</span>}
      </div>
      {close && <p className="jev-result__hint">The candidates are close, so any of them would do.</p>}
      <Footer confidence={formatJevPercent(result.confidence)} model={result.report?.model ?? null} />
    </div>
  );
}

const ASPECT_TOLERANCE = 0.02;

function JevBoxView({ result, params, image }: { result: JevBoxResult; params: Record<string, unknown>; image: string | null | undefined }) {
  // The overlay is drawn in fractions of the original image. If the wired image
  // no longer has the same shape (it changed since the run), show the run's own
  // annotated image instead, which already has the box burned in.
  const [mismatch, setMismatch] = useState(false);
  const target = askedQuestion(result.report, params, 'target', 'Target');
  const box = result.box;
  const useOriginal = Boolean(image) && !mismatch;
  const src = useOriginal ? image! : result.annotated;
  // Only a found target comes with a box. Unsure and not found both give
  // just the verdict, so they share the centred status in place of a box.
  const overlay = useOriginal && box !== null && result.found === 'true';
  const noBox = result.found !== 'true';
  const tone: Tone = result.found === 'true' ? 'pass' : result.found === 'unsure' ? 'unsure' : 'none';
  const label = result.found === 'true' ? 'Found' : result.found === 'unsure' ? 'Unsure' : 'Not found';
  const presence = parseJevNumber(result.report?.fields.Presence);
  const boxConfidence = box ? (box.confidence === null ? null : formatJevPercent(box.confidence)) : undefined;

  const checkAspect = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!box || !useOriginal) return;
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (!naturalWidth || !naturalHeight) return;
    const shown = naturalWidth / naturalHeight;
    const expected = box.image.w / box.image.h;
    if (Math.abs(shown - expected) / expected > ASPECT_TOLERANCE) setMismatch(true);
  };

  return (
    <div className={`jev-result jev-result--box jev-result--${result.found === 'false' ? 'missing' : tone}`} data-testid="jev-result" data-kind="box" data-found={result.found}>
      <div className="jev-result__top">
        <Chip tone={tone}>{label}</Chip>
        {judgedImages(result.report) && <ExperimentalBadge />}
      </div>
      {target && <p className="jev-result__question" title={target}><span className="jev-result__muted">Find</span> {target}</p>}
      {src ? (
        <div
          className="jev-result__stage"
          style={box ? { aspectRatio: `${box.image.w} / ${box.image.h}` } : undefined}
        >
          <img src={backendAssetUrlSync(src)} alt={target ? `Searched for ${target}` : 'Searched image'} draggable={false} onLoad={checkAspect} />
          {overlay && box && (
            <>
              <svg className="jev-result__overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                <path
                  className="jev-result__scrim"
                  fillRule="evenodd"
                  d={`M0 0H1V1H0Z M${box.left} ${box.top}V${box.bottom}H${box.right}V${box.top}Z`}
                />
              </svg>
              {/* The outline lives in its own pixel-sized SVG so pathLength
                  draws it in evenly; the scrim above is in image fractions. */}
              <svg
                className="jev-result__frame"
                style={{
                  left: `${box.left * 100}%`, top: `${box.top * 100}%`,
                  width: `${(box.right - box.left) * 100}%`, height: `${(box.bottom - box.top) * 100}%`,
                }}
                aria-hidden="true"
              >
                <rect className="jev-result__box jev-result__box--glow" width="100%" height="100%" rx="2" pathLength={1} />
                <rect className="jev-result__box" width="100%" height="100%" rx="2" pathLength={1} />
              </svg>
              <span
                className={`jev-result__box-label${box.top < 0.12 ? ' jev-result__box-label--inside' : ''}`}
                style={{ left: `${box.left * 100}%`, top: `${box.top * 100}%` }}
              >
                {boxConfidence === null ? 'No confidence reported' : boxConfidence}
              </span>
            </>
          )}
          {noBox && (
            <div className="jev-result__missing" role="status">
              <span className="jev-result__missing-title">{label}</span>
              {target && <span className="jev-result__missing-target">{target}</span>}
            </div>
          )}
        </div>
      ) : (
        noBox && (
          <div className="jev-result__missing jev-result__missing--plain" role="status">
            <span className="jev-result__missing-title">{label}</span>
            {target && <span className="jev-result__missing-target">{target}</span>}
          </div>
        )
      )}
      {result.found === 'unsure' && <p className="jev-result__hint">Jev couldn&apos;t tell whether it&apos;s there, so there is no box, crop or mask.</p>}
      <div className="jev-result__footer">
        <span>
          Presence {presence !== null ? <span className="jev-result__figure">{formatJevPercent(presence)}</span> : <span className="jev-result__muted">unknown</span>}
          {box && (
            <>
              {' · Box '}
              {boxConfidence === null
                ? <span className="jev-result__muted">no confidence reported</span>
                : <span className="jev-result__figure">{boxConfidence}</span>}
            </>
          )}
        </span>
        {result.report?.model && <span className="jev-result__model">{result.report.model}</span>}
      </div>
    </div>
  );
}

/** A Jev node's result on its card: verdict, the numbers behind it, and for
 * Pick Best and Box the images it judged. */
export function JevResultView({ result, params, inputs }: JevResultViewProps) {
  if (result.kind === 'decide') return <JevDecideView result={result} params={params} gated={Boolean(inputs?.gated)} />;
  if (result.kind === 'pick-best') return <JevPickBestView result={result} params={params} candidates={inputs?.candidates} />;
  return <JevBoxView result={result} params={params} image={inputs?.image} />;
}
