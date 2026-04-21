import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Mode = 'outgoing' | 'incoming';

interface Props {
  /** Number of residues along one axis of the pair-representation grid. */
  N?: number;
  /** Initial pair (i, j). Default: (2, 7). */
  initial?: { i: number; j: number };
  /** Starting mode. Default 'outgoing'. */
  initialMode?: Mode;
}

const CELL = 30;
const PAD = 44;
const GUTTER = 6;

// Small helper: clamp an integer to [0, max]
const clamp = (x: number, max: number) => Math.max(0, Math.min(max, x));

/**
 * Visualizer for AlphaFold2's triangle multiplicative update (Algorithms 11
 * and 12 of the supplement). The operation itself is:
 *
 *   outgoing:   z_ij  <-  g_ij ⊙ Linear( sum_k  a_ik ⊙ b_jk )
 *   incoming:   z_ij  <-  g_ij ⊙ Linear( sum_k  a_ki ⊙ b_kj )
 *
 * The component animates the sum-over-k step by step, so that for a chosen
 * target pair (i, j) you can see which pair of cells the model is combining
 * at each step. In outgoing mode the two contributing cells sit on row i and
 * row j; in incoming mode they sit on column i and column j.
 *
 * The grid is just a stylised NxN pair representation. Click any cell to
 * change the target pair. The "triangle" in the name is literal: for every
 * k, the three cells (i,j), (i,k), (j,k) — or their transposed incoming
 * counterparts — form a triangle in index space, and every outer Evoformer
 * pass shrinks the error on each one of those three edges jointly.
 */
export default function TriMulAnimator({
  N = 10,
  initial = { i: 2, j: 7 },
  initialMode = 'outgoing',
}: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [selected, setSelected] = useState(() => ({
    i: clamp(initial.i, N - 1),
    j: clamp(initial.j, N - 1),
  }));
  const [k, setK] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedMs, setSpeedMs] = useState(650);
  const [reduced, setReduced] = useState(false);

  // Respect prefers-reduced-motion: pause autoplay on first load, let the
  // user drive the animation with the Step/Play buttons.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      setReduced(mq.matches);
      if (mq.matches) setPlaying(false);
    };
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  // Drive the k index when playing. We skip k == i and k == j because the
  // diagonal k's are trivially self-contributions; the paper's code doesn't
  // mask them, but they add no pedagogical value.
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const tick = (t: number) => {
      if (cancelled) return;
      if (t - lastTickRef.current >= speedMs) {
        lastTickRef.current = t;
        setK((prev) => {
          let next = (prev + 1) % N;
          if (next === selected.i || next === selected.j) {
            next = (next + 1) % N;
          }
          return next;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speedMs, selected.i, selected.j, N]);

  const { i, j } = selected;
  const step = useMemo(() => {
    const a = mode === 'outgoing' ? { r: i, c: k } : { r: k, c: i };
    const b = mode === 'outgoing' ? { r: j, c: k } : { r: k, c: j };
    const z = { r: i, c: j };
    return { a, b, z };
  }, [i, j, k, mode]);

  const width = N * CELL + 2 * PAD;
  const height = N * CELL + 2 * PAD;

  // Convert (row, col) -> SVG rectangle top-left
  const cellXY = (r: number, c: number) => ({
    x: PAD + c * (CELL + GUTTER / N) - (c * GUTTER) / (N - 1) + c,
    y: PAD + r * (CELL + GUTTER / N) - (r * GUTTER) / (N - 1) + r,
  });
  // Cell center, for drawing the triangle
  const center = (r: number, c: number) => {
    const { x, y } = cellXY(r, c);
    return { x: x + CELL / 2, y: y + CELL / 2 };
  };

  const onCellClick = (r: number, c: number) => {
    setSelected({ i: r, j: c });
  };

  const stepOnce = useCallback(() => {
    setPlaying(false);
    setK((prev) => {
      let next = (prev + 1) % N;
      if (next === selected.i || next === selected.j) next = (next + 1) % N;
      return next;
    });
  }, [N, selected.i, selected.j]);

  const reset = useCallback(() => {
    setK(0);
    setPlaying(false);
  }, []);

  const equation =
    mode === 'outgoing'
      ? `z_{${i},${j}} \\mathrel{+}= a_{${i},${k}} \\odot b_{${j},${k}}`
      : `z_{${i},${j}} \\mathrel{+}= a_{${k},${i}} \\odot b_{${k},${j}}`;

  // Build the cell grid. Each cell is a <rect>. Visual states:
  // - base: subtle fill
  // - diagonal (r == c): slightly different tint (self-pairs, no data)
  // - target (i, j): accent border
  // - a-cell and b-cell: accent fill (current k)
  const cells = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const { x, y } = cellXY(r, c);
      const isTarget = r === step.z.r && c === step.z.c;
      const isA = r === step.a.r && c === step.a.c;
      const isB = r === step.b.r && c === step.b.c;
      const isDiagonal = r === c;
      let cls = 'tri-cell';
      if (isTarget) cls += ' tri-cell--target';
      if (isA) cls += ' tri-cell--a';
      if (isB) cls += ' tri-cell--b';
      if (isDiagonal && !isTarget && !isA && !isB) cls += ' tri-cell--diagonal';
      cells.push(
        <rect
          key={`${r}-${c}`}
          x={x}
          y={y}
          width={CELL}
          height={CELL}
          rx={3}
          ry={3}
          className={cls}
          onClick={() => onCellClick(r, c)}
          role="button"
          aria-label={`Select pair (${r}, ${c})`}
          tabIndex={0}
        />,
      );
    }
  }

  // Triangle overlay connecting the three active cells
  const za = center(step.z.r, step.z.c);
  const aa = center(step.a.r, step.a.c);
  const ba = center(step.b.r, step.b.c);
  const trianglePath = `M${za.x},${za.y} L${aa.x},${aa.y} L${ba.x},${ba.y} Z`;

  return (
    <figure className="tri-root">
      <div className="tri-controls" role="group" aria-label="Animation controls">
        <div className="tri-modeswitch" role="tablist" aria-label="Update direction">
          <button
            role="tab"
            aria-selected={mode === 'outgoing'}
            className={mode === 'outgoing' ? 'tri-seg tri-seg--on' : 'tri-seg'}
            onClick={() => setMode('outgoing')}
          >
            Outgoing
          </button>
          <button
            role="tab"
            aria-selected={mode === 'incoming'}
            className={mode === 'incoming' ? 'tri-seg tri-seg--on' : 'tri-seg'}
            onClick={() => setMode('incoming')}
          >
            Incoming
          </button>
        </div>

        <div className="tri-btns">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? 'Pause animation' : 'Play animation'}
            className="tri-btn"
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" onClick={stepOnce} aria-label="Advance one step" className="tri-btn">
            Step
          </button>
          <button type="button" onClick={reset} aria-label="Reset" className="tri-btn">
            Reset
          </button>
        </div>

        <label className="tri-speed">
          <span className="tri-speed-label">Speed</span>
          <input
            type="range"
            min={200}
            max={1200}
            step={50}
            value={1400 - speedMs}
            onChange={(e) => setSpeedMs(1400 - Number(e.currentTarget.value))}
            aria-label="Animation speed"
          />
        </label>
      </div>

      <div className="tri-viewport">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="tri-svg"
          role="img"
          aria-label={`Triangle multiplicative update, ${mode} mode, target pair ${i},${j}, current k=${k}`}
        >
          {/* Axis labels */}
          {Array.from({ length: N }).map((_, idx) => (
            <g key={`label-${idx}`}>
              <text
                x={PAD + idx * (CELL + GUTTER / N) - (idx * GUTTER) / (N - 1) + idx + CELL / 2}
                y={PAD - 12}
                textAnchor="middle"
                className={`tri-label${idx === step.z.c ? ' tri-label--active' : ''}`}
              >
                {idx}
              </text>
              <text
                x={PAD - 14}
                y={PAD + idx * (CELL + GUTTER / N) - (idx * GUTTER) / (N - 1) + idx + CELL / 2 + 4}
                textAnchor="end"
                className={`tri-label${idx === step.z.r ? ' tri-label--active' : ''}`}
              >
                {idx}
              </text>
            </g>
          ))}
          {/* Grid cells */}
          {cells}
          {/* Triangle connecting the three active cells */}
          <path d={trianglePath} className="tri-path" />
          {/* Cell-center dots for active cells */}
          <circle cx={za.x} cy={za.y} r={3.5} className="tri-dot tri-dot--z" />
          <circle cx={aa.x} cy={aa.y} r={3.5} className="tri-dot tri-dot--a" />
          <circle cx={ba.x} cy={ba.y} r={3.5} className="tri-dot tri-dot--b" />
        </svg>
      </div>

      <figcaption className="tri-caption">
        <div className="tri-eqn">
          <span className="tri-eqn-k">k = {k}</span>
          <code>{equation.replace(/\\mathrel\{\+\}=/, '+=').replace(/\\odot/g, '⊙')}</code>
        </div>
        <div className="tri-hint">
          {mode === 'outgoing' ? (
            <>
              <strong>Outgoing.</strong> For the target edge <em>z<sub>{i},{j}</sub></em>, sum over
              every residue <em>k</em> the elementwise product of row-<em>i</em> entry{' '}
              <em>a<sub>{i},k</sub></em> and row-<em>j</em> entry <em>b<sub>{j},k</sub></em>. Each{' '}
              <em>k</em> closes a triangle <em>i → k ← j</em>.
            </>
          ) : (
            <>
              <strong>Incoming.</strong> For the target edge <em>z<sub>{i},{j}</sub></em>, sum over
              every residue <em>k</em> the elementwise product of column-<em>i</em> entry{' '}
              <em>a<sub>k,{i}</sub></em> and column-<em>j</em> entry <em>b<sub>k,{j}</sub></em>.
              Each <em>k</em> closes a triangle <em>k → i, k → j</em>.
            </>
          )}
          {reduced && (
            <>
              {' '}
              <span className="tri-muted">(Reduced-motion mode: step with the Step button.)</span>
            </>
          )}
        </div>
      </figcaption>

      <style>{`
        .tri-root {
          margin: 1.5rem 0;
          border: 1px solid var(--rule);
          border-radius: 6px;
          padding: 0.9rem 1rem 1rem;
          background: color-mix(in oklab, var(--bg) 94%, var(--rule) 6%);
          font-family: var(--font-sans);
        }
        .tri-controls {
          display: flex;
          align-items: center;
          gap: 0.9rem;
          flex-wrap: wrap;
          margin-bottom: 0.75rem;
        }
        .tri-modeswitch {
          display: inline-flex;
          border: 1px solid var(--rule);
          border-radius: 4px;
          overflow: hidden;
        }
        .tri-seg {
          border: none;
          background: transparent;
          padding: 0.3rem 0.7rem;
          font: inherit;
          font-size: 0.82rem;
          color: var(--fg-muted);
          cursor: pointer;
          border-right: 1px solid var(--rule);
        }
        .tri-seg:last-child { border-right: none; }
        .tri-seg--on {
          background: var(--accent);
          color: white;
        }
        .tri-btns { display: inline-flex; gap: 0.35rem; }
        .tri-btn {
          font-size: 0.82rem;
          padding: 0.3rem 0.7rem;
          border: 1px solid var(--rule);
          border-radius: 4px;
          background: transparent;
          color: var(--fg);
          cursor: pointer;
        }
        .tri-btn:hover { border-color: var(--fg-muted); }
        .tri-speed {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          font-size: 0.78rem;
          color: var(--fg-muted);
          margin-left: auto;
        }
        .tri-speed-label { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; }
        .tri-viewport {
          display: flex;
          justify-content: center;
          overflow-x: auto;
        }
        .tri-svg {
          max-width: 100%;
          height: auto;
          min-width: 360px;
        }
        .tri-cell {
          fill: color-mix(in oklab, var(--rule) 55%, transparent);
          stroke: color-mix(in oklab, var(--rule) 80%, transparent);
          stroke-width: 0.5;
          cursor: pointer;
          transition: fill 120ms ease, stroke 120ms ease;
        }
        .tri-cell:hover {
          fill: color-mix(in oklab, var(--rule) 80%, transparent);
        }
        .tri-cell--diagonal {
          fill: color-mix(in oklab, var(--rule) 25%, transparent);
        }
        .tri-cell--target {
          fill: color-mix(in oklab, var(--accent) 22%, transparent);
          stroke: var(--accent);
          stroke-width: 2;
        }
        .tri-cell--a {
          fill: color-mix(in oklab, var(--accent) 55%, transparent);
          stroke: var(--accent);
          stroke-width: 1.4;
        }
        .tri-cell--b {
          fill: color-mix(in oklab, var(--accent) 55%, transparent);
          stroke: var(--accent);
          stroke-width: 1.4;
        }
        .tri-label {
          font-size: 10px;
          font-family: var(--font-mono);
          fill: var(--fg-muted);
        }
        .tri-label--active { fill: var(--accent); font-weight: 600; }
        .tri-path {
          fill: none;
          stroke: var(--accent);
          stroke-width: 1.25;
          stroke-dasharray: 3 3;
          opacity: 0.7;
        }
        .tri-dot--z { fill: var(--accent); }
        .tri-dot--a, .tri-dot--b { fill: var(--accent); }
        .tri-caption {
          margin-top: 0.8rem;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          font-size: 0.88rem;
          color: var(--fg);
        }
        .tri-eqn {
          display: flex;
          align-items: baseline;
          gap: 0.75rem;
          font-family: var(--font-mono);
          padding: 0.35rem 0.6rem;
          background: color-mix(in oklab, var(--rule) 25%, transparent);
          border-radius: 4px;
          font-size: 0.85rem;
        }
        .tri-eqn-k {
          font-weight: 600;
          color: var(--accent);
          font-size: 0.82rem;
        }
        .tri-hint {
          font-size: 0.85rem;
          line-height: 1.5;
          color: var(--fg-muted);
        }
        .tri-hint strong { color: var(--fg); }
        .tri-muted { font-style: italic; }
      `}</style>
    </figure>
  );
}
