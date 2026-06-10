import { useState } from 'react';
import { X } from 'lucide-react';
import { CrabMark } from './CrabMark';
import { CrabMarkAnimated } from './CrabMarkAnimated';
import { HelixMark } from './HelixMark';
import { MARK_MODES, MARK_MODE_KEYS, type MarkMode } from './crabModes';
import { useUIStore } from '../../store/uiStore';
import './BrandShowcase.css';

/**
 * Nebula Nodes — Dynamic Mark showcase.
 *
 * Standalone reference + demo surface for the animated NN-45 Crab mark.
 * Recreates the Claude Design "Dynamic Mark" page as a real route: a live
 * hero with a mode switcher, every motion mode side by side, and the
 * product state map that says where each belongs. Reachable at `#brand`.
 *
 * This is a brand surface, not product chrome — it deliberately uses the
 * full crab-true gradient (product UI stays on the single Slava accent).
 */

/** Where each motion belongs in the product. */
const STATE_MAP: { mode: MarkMode; state: string; use: string }[] = [
  {
    mode: 'breathe',
    state: 'Idle / at rest',
    use: 'App icon, splash screen, anywhere the mark sits without a job.',
  },
  {
    mode: 'twinkle',
    state: 'Ambient background',
    use: 'Behind empty canvas, behind the agent log when collapsed.',
  },
  {
    mode: 'boot',
    state: 'Loading · starting up',
    use: 'App boot, switching workspaces, restoring a saved graph.',
  },
  {
    mode: 'scan',
    state: 'Searching · discovery',
    use: 'Library search, model picker spinner, semantic search across nodes.',
  },
  {
    mode: 'pulse',
    state: 'Executing graph',
    use: 'While a node or the full graph runs. Wave matches the execution heartbeat.',
  },
  {
    mode: 'thinking',
    state: 'AI is working',
    use: 'Inside the chat composer while the model is generating.',
  },
  {
    mode: 'drift',
    state: 'Ambient (subtle)',
    use: "Footer wordmark, distant marks. Motion you'd only notice if it stopped.",
  },
];

function HeroShowcase({ mode }: { mode: MarkMode }) {
  const m = MARK_MODES[mode];
  return (
    <div className="nn-bs-hero">
      <div className="nn-bs-hero__field" aria-hidden="true" />
      <div className="nn-bs-hero__telemetry nn-bs-hero__telemetry--top">
        <span>nebula·nodes / dynamic mark</span>
        <span>{m.label.toUpperCase()} · LIVE</span>
        <span>NGC 1952 · M1</span>
      </div>
      <div className="nn-bs-hero__center">
        <CrabMarkAnimated mode={mode} size={400} />
        <div className="nn-bs-hero__label">
          <div className="nn-bs-hero__title">{m.label}</div>
          <div className="nn-bs-hero__desc">{m.desc}</div>
          <div className="nn-bs-hero__state">STATE · {m.state}</div>
        </div>
      </div>
      <div className="nn-bs-hero__telemetry nn-bs-hero__telemetry--bottom">
        <span>60 FPS · SVG · RAF</span>
        <span>switch mode below ↓</span>
        <span>crab-true palette</span>
      </div>
    </div>
  );
}

function ModeCard({ mode, code }: { mode: MarkMode; code: string }) {
  const m = MARK_MODES[mode];
  return (
    <div className="nn-bs-card">
      <div className="nn-bs-card__field" aria-hidden="true" />
      <div className="nn-bs-card__telemetry">
        <span>
          {code} · {mode}
        </span>
        <span className="nn-bs-card__live">
          <span className="nn-bs-card__live-dot" />
          LIVE
        </span>
      </div>
      <div className="nn-bs-card__mark">
        <CrabMarkAnimated mode={mode} size={240} />
      </div>
      <div className="nn-bs-card__caption">
        <div className="nn-bs-card__caption-row">
          <span className="nn-bs-card__label">{m.label}</span>
          <span className="nn-bs-card__state">{m.state}</span>
        </div>
        <p className="nn-bs-card__desc">{m.desc}</p>
      </div>
    </div>
  );
}

export function BrandShowcaseView() {
  const exitBrandShowcase = useUIStore((s) => s.exitBrandShowcase);
  const [heroMode, setHeroMode] = useState<MarkMode>('thinking');

  const close = () => {
    // Clear the hash so the route doesn't re-trigger on the App effect.
    if (window.location.hash) {
      history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    }
    exitBrandShowcase();
  };

  return (
    <div className="nn-bs">
      <header className="nn-bs__bar">
        <div className="nn-bs__brand">
          <span>NEBULA·NODES</span>
          <span className="nn-bs__brand-dot" />
          <span>DYNAMIC MARK</span>
          <span className="nn-bs__brand-meta">
            {MARK_MODE_KEYS.length} modes
          </span>
        </div>
        <button
          type="button"
          className="nn-bs__close"
          onClick={close}
          aria-label="Close showcase"
          title="Close"
        >
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>

      <main className="nn-bs__scroll">
        {/* Section 1 — live hero */}
        <section className="nn-bs__section">
          <div className="nn-bs__section-head">
            <h2 className="nn-bs__section-title">Hero · live</h2>
            <p className="nn-bs__section-sub">
              Pick a mode to drive this card. Each mode is intended for a
              specific product state.
            </p>
          </div>
          <div className="nn-bs__hero-wrap">
            <HeroShowcase mode={heroMode} />
          </div>
          <div className="nn-bs__switcher" role="tablist" aria-label="Hero mode">
            {MARK_MODE_KEYS.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={m === heroMode}
                className={`nn-bs__chip${
                  m === heroMode ? ' nn-bs__chip--active' : ''
                }`}
                onClick={() => setHeroMode(m)}
              >
                {MARK_MODES[m].label}
              </button>
            ))}
          </div>
        </section>

        {/* Section 2 — all modes */}
        <section className="nn-bs__section">
          <div className="nn-bs__section-head">
            <h2 className="nn-bs__section-title">All modes · side by side</h2>
            <p className="nn-bs__section-sub">
              {MARK_MODE_KEYS.length} motion variants. Every card runs its own
              RAF loop — no shared clock.
            </p>
          </div>
          <div className="nn-bs__grid">
            {MARK_MODE_KEYS.map((m, i) => (
              <ModeCard
                key={m}
                mode={m}
                code={`DYN-0${i + 1}`}
              />
            ))}
          </div>
        </section>

        {/* Section 3 — nebula logo variants */}
        <section className="nn-bs__section">
          <div className="nn-bs__section-head">
            <h2 className="nn-bs__section-title">Nebula variants</h2>
            <p className="nn-bs__section-sub">
              Same halftone engine — procedural mask + radial palette. Crab is
              locked (M1); Helix is an exploratory planetary-nebula direction.
            </p>
          </div>
          <div className="nn-bs__variants">
            <article className="nn-bs__variant">
              <div className="nn-bs__variant-mark">
                <CrabMark size={320} title="Crab Nebula M1" />
              </div>
              <div className="nn-bs__variant-meta">
                <div className="nn-bs__variant-code">NN-45 · CRAB</div>
                <div className="nn-bs__variant-id">NGC 1952 · M1 · TAURUS</div>
                <p className="nn-bs__variant-desc">
                  Supernova remnant — filamentary torus, teal core, warm-orange
                  shell. Locked product mark with seven motion modes.
                </p>
                <div className="nn-bs__variant-palette">
                  <span
                    className="nn-bs__swatch"
                    style={{ background: 'rgb(180,240,250)' }}
                  />
                  <span
                    className="nn-bs__swatch"
                    style={{ background: 'rgb(120,220,200)' }}
                  />
                  <span
                    className="nn-bs__swatch"
                    style={{ background: 'rgb(240,150,90)' }}
                  />
                  <span
                    className="nn-bs__swatch"
                    style={{ background: 'rgb(120,50,30)' }}
                  />
                  <span className="nn-bs__variant-palette-label">
                    crab-true
                  </span>
                </div>
              </div>
            </article>
            <article className="nn-bs__variant">
              <div className="nn-bs__variant-mark">
                <HelixMark size={320} title="Helix Nebula NGC 7293" />
              </div>
              <div className="nn-bs__variant-meta">
                <div className="nn-bs__variant-code">NN-73 · HELIX</div>
                <div className="nn-bs__variant-id">
                  NGC 7293 · PHASE 1 · CORE
                </div>
                <p className="nn-bs__variant-desc">
                  Pale cyan center + thick dark-cobalt ring (reference
                  structure). Orange iris is phase 2.
                </p>
                <div className="nn-bs__variant-palette">
                  <span
                    className="nn-bs__swatch"
                    style={{ background: 'rgb(242,252,255)' }}
                  />
                  <span
                    className="nn-bs__swatch"
                    style={{ background: 'rgb(48,92,168)' }}
                  />
                  <span
                    className="nn-bs__swatch"
                    style={{ background: 'rgb(32,72,148)' }}
                  />
                  <span className="nn-bs__variant-palette-label">
                    helix-core
                  </span>
                </div>
              </div>
            </article>
          </div>
        </section>

        {/* Section 4 — product state map */}
        <section className="nn-bs__section">
          <div className="nn-bs__section-head">
            <h2 className="nn-bs__section-title">Product states</h2>
            <p className="nn-bs__section-sub">
              How each motion maps to a place in the product.
            </p>
          </div>
          <div className="nn-bs__statemap">
            <div className="nn-bs__statemap-head">MOTION · STATE MAPPING</div>
            {STATE_MAP.map(({ mode, state, use }) => (
              <div key={mode} className="nn-bs__staterow">
                <div className="nn-bs__staterow-mark">
                  <CrabMarkAnimated mode={mode} size={48} />
                </div>
                <div className="nn-bs__staterow-state">{state}</div>
                <div className="nn-bs__staterow-use">{use}</div>
              </div>
            ))}
          </div>
        </section>

        <footer className="nn-bs__foot">
          <span>Plotted with light.</span>
          <span>NN-45 · CRAB · M1 — crab-true palette</span>
        </footer>
      </main>
    </div>
  );
}
