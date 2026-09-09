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
const GUTTER = 2;

// Small helper: clamp an integer to [0, max]
const clamp = (x: number, max: number) => Math.max(0, Math.min(max, x));

/** Interactive tensor-coordinate view of the triangle contraction.
 * A and B are distinct projected/gated features. Their elementwise
 * products are summed over every k before the learned output transforms.
 */
export default function TriMulAnimator({
  N = 10,
  initial = { i: 2, j: 7 },
  initialMode = 'outgoing',
}: Props) {
  N = Math.max(2, Math.min(16, Math.trunc(N)));
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

  // Include every residue, including k == i and k == j.
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    lastTickRef.current = performance.now();
    const tick = (t: number) => {
      if (cancelled) return;
      if (t - lastTickRef.current >= speedMs) {
        lastTickRef.current = t;
        setK((prev) => (prev + 1) % N);
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

  const width = N * (CELL + GUTTER) + 2 * PAD;
  const height = N * (CELL + GUTTER) + 2 * PAD;

  // Convert (row, col) -> SVG rectangle top-left
  const cellXY = (r: number, c: number) => ({
    x: PAD + c * (CELL + GUTTER),
    y: PAD + r * (CELL + GUTTER),
  });
  // Cell center, for drawing the triangle
  const center = (r: number, c: number) => {
    const { x, y } = cellXY(r, c);
    return { x: x + CELL / 2, y: y + CELL / 2 };
  };

  const onCellClick = (r: number, c: number) => {
    setSelected({ i: r, j: c });
    setPlaying(false);
  };

  const stepOnce = useCallback(() => {
    setPlaying(false);
    setK((prev) => (prev + 1) % N);
  }, [N]);

  const reset = useCallback(() => {
    setK(0);
    setPlaying(false);
  }, []);

  const equation = `u(${k}) = A[${step.a.r}, ${step.a.c}] ⊙ B[${step.b.r}, ${step.b.c}]`;

  // Build the cell grid. Each cell is a <rect>. Visual states:
  // - base: subtle fill
  // - diagonal (r == c): self-pairs, included in the contraction
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
          aria-label={`Pair (${r}, ${c})`}
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
      <figcaption className="tri-heading"><strong>Triangle multiplicative update</strong><span>Pick a pair, then follow the sweep through k.</span></figcaption>
      <div className="tri-controls" role="group" aria-label="Animation controls">
        <div className="tri-modeswitch" role="group" aria-label="Update direction">
          <button
            type="button"
            aria-pressed={mode === 'outgoing'}
            className={mode === 'outgoing' ? 'tri-seg tri-seg--on' : 'tri-seg'}
            onClick={() => { setMode('outgoing'); setPlaying(false); }}
          >
            Outgoing
          </button>
          <button
            type="button"
            aria-pressed={mode === 'incoming'}
            className={mode === 'incoming' ? 'tri-seg tri-seg--on' : 'tri-seg'}
            onClick={() => { setMode('incoming'); setPlaying(false); }}
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

      <div className="tri-scrub">
        <label>Residue i<select aria-label="Target residue i" value={i} onChange={(event) => onCellClick(Number(event.target.value), j)}>{Array.from({length:N}, (_, index) => <option key={index} value={index}>{index}</option>)}</select></label>
        <label>Residue j<select aria-label="Target residue j" value={j} onChange={(event) => onCellClick(i, Number(event.target.value))}>{Array.from({length:N}, (_, index) => <option key={index} value={index}>{index}</option>)}</select></label>
        <label className="tri-k-slider">Third residue k <strong>{k}</strong><input type="range" min={0} max={N-1} step={1} value={k} aria-label="Third residue k" onChange={(event) => { setK(Number(event.target.value)); setPlaying(false); }} /></label>
      </div>
      <div className="tri-live-key"><span className="tri-key-z">Target z[{i}, {j}]</span><span className="tri-key-a">A[{step.a.r}, {step.a.c}]</span><span className="tri-key-b">B[{step.b.r}, {step.b.c}]</span></div>

      <div className="tri-viewport">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="tri-svg"
          role="img"
          aria-label={`Triangle multiplicative update, ${mode} mode, target pair ${i},${j}, current k=${k}`}
        >
          <text x={width / 2} y={16} textAnchor="middle" className="tri-axis-title">Column</text>
          <text x={10} y={height / 2} textAnchor="middle" transform={`rotate(-90 10 ${height / 2})`} className="tri-axis-title">Row</text>
          {/* Axis labels */}
          {Array.from({ length: N }).map((_, idx) => (
            <g key={`label-${idx}`}>
              <text
                x={PAD + idx * (CELL + GUTTER) + CELL / 2}
                y={PAD - 12}
                textAnchor="middle"
                className={`tri-label${idx === step.z.c ? ' tri-label--active' : ''}`}
              >
                {idx}
              </text>
              <text
                x={PAD - 14}
                y={PAD + idx * (CELL + GUTTER) + CELL / 2 + 4}
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

      <div className="tri-caption">
        <div className="tri-eqn">
          <span className="tri-eqn-k">k = {k}</span>
          <code>{equation}</code>
        </div>
        <p className="tri-hint">{mode === 'outgoing' ? `The two inputs share column k = ${k}; they come from rows i and j of separate projections.` : `The two inputs share row k = ${k}; they come from columns i and j of separate projections.`} The update multiplies matching channels and sums the products over all {N} values of k.</p>
        <details className="tri-detail"><summary>How this becomes a pair update</summary><p>A and B are separate learned projections with input gates. After the sum, AlphaFold2 applies LayerNorm, a linear layer, and an output gate, then adds the result to z[{i}, {j}]. The sum includes every k, even k = i or k = j. Dashed lines connect matrix entries; they do not show a protein’s physical geometry.</p></details>
        {reduced && <p className="tri-hint">Reduced motion is on. Use Step or the k slider, or press Play to animate.</p>}
      </div>

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
          color: var(--bg);
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
          width: min(100%, 480px);
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
          pointer-events: none;
          opacity: 0.7;
        }
        .tri-dot { pointer-events: none; }
        .tri-dot--z { fill: var(--accent); }
        .tri-dot--a { fill: var(--accent); }
        .tri-dot--b { fill: var(--data-msa); }
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
          flex-wrap: wrap;
          overflow-wrap: anywhere;
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

        .tri-heading { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:.35rem 1rem; margin:0 0 1rem; color:var(--fg); }
        .tri-heading strong { font:600 1rem/1.4 var(--font-sans); }.tri-heading span { color:var(--fg-muted); font-size:.76rem; }
        .tri-scrub { display:flex; align-items:end; flex-wrap:wrap; gap:.75rem; padding:.8rem; background:var(--surface); border:1px solid var(--rule); border-radius:.45rem; }
        .tri-scrub label { display:grid; gap:.3rem; font-size:.69rem; color:var(--fg-muted); }.tri-scrub select { min-width:4rem; min-height:36px; padding:.35rem .6rem; background:var(--surface-strong); color:var(--fg); border:1px solid var(--rule); border-radius:.3rem; font-size:.8rem; }.tri-scrub .tri-k-slider { flex:1; min-width:130px; grid-template-columns:1fr auto; }.tri-k-slider input { grid-column:1 / -1; width:100%; accent-color:var(--accent); }.tri-k-slider strong { color:var(--accent); font-family:var(--font-mono); }
        .tri-live-key { display:flex; justify-content:center; flex-wrap:wrap; gap:.5rem 1rem; margin:1rem 0 .1rem; font:600 .7rem var(--font-mono); }.tri-live-key span::before { display:inline-block; width:.5rem; height:.5rem; margin-right:.4rem; border-radius:2px; content:''; background:currentColor; }.tri-key-z,.tri-key-a { color:var(--accent); }.tri-key-z::before { background:none!important; outline:1.5px solid currentColor; }.tri-key-b { color:var(--data-msa); }.tri-axis-title { fill:var(--fg-muted); font:11px var(--font-sans); }
        .tri-cell--b { fill:color-mix(in oklab,var(--data-msa) 42%,var(--bg)); stroke:var(--data-msa); }.tri-cell--target { stroke-width:2.5; stroke:var(--fg); }.tri-cell--a.tri-cell--b { fill:color-mix(in oklab,var(--data-msa) 48%,var(--accent)); }.tri-cell:focus-visible { stroke:var(--focus); stroke-width:3; }
        .tri-root .tri-hint { margin:.4rem 0 0; font-size:.76rem; line-height:1.65; }.tri-detail { margin-top:.7rem; border-top:1px solid var(--rule); padding-top:.6rem; font-size:.74rem; color:var(--fg-muted); }.tri-detail summary { cursor:pointer; color:var(--accent); }.tri-root .tri-detail p { margin:.5rem 0 0; line-height:1.7; }.tri-root .tri-eqn code { border:0; background:none; padding:0; font-size:.79rem; }.tri-root .tri-btn,.tri-root .tri-seg { min-height:36px; }.tri-speed input { max-width:105px; accent-color:var(--accent); }
        @media(max-width:520px) { .tri-root { padding:.85rem; }.tri-controls { gap:.6rem; }.tri-speed { margin-left:0; }.tri-svg { min-width:0; }.tri-btns { gap:.3rem; }.tri-btn { padding:.35rem .6rem; }.tri-live-key { gap:.55rem; font-size:.64rem; }.tri-scrub { gap:.55rem; }.tri-eqn { gap:.4rem; }.tri-heading span { font-size:.72rem; } }
      `}</style>
    </figure>
  );
}
