import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Mode = 'row' | 'col';

interface Species {
  icon: string;
  name: string;
}

// Five organisms matching the §1.2 cytochrome c MSA figure. Icons are emoji
// so they render without extra assets; worst case, a browser falls back to a
// tofu box and the species name carries the meaning.
const ORGANISMS: Species[] = [
  { icon: '🧑', name: 'H. sapiens' },
  { icon: '🐴', name: 'E. caballus' },
  { icon: '🐔', name: 'G. gallus' },
  { icon: '🪰', name: 'D. melanogaster' },
  { icon: '🍄', name: 'S. cerevisiae' },
];

// 10-column window from the §1.2 alignment: aligned columns 6..15, i.e. the
// core region where every species has content (no gaps). Each row here is
// verbatim from the MSA in §1.2 — this widget is just animating the same
// tensor.
const MSA: string[][] = [
  ['G', 'D', 'V', 'E', 'K', 'G', 'K', 'K', 'I', 'F'], // H. sapiens
  ['G', 'D', 'V', 'E', 'K', 'G', 'K', 'K', 'I', 'F'], // E. caballus
  ['G', 'D', 'I', 'E', 'K', 'G', 'K', 'K', 'I', 'F'], // G. gallus
  ['G', 'D', 'V', 'E', 'K', 'G', 'K', 'K', 'L', 'F'], // D. melanogaster
  ['G', 'S', 'A', 'K', 'K', 'G', 'A', 'T', 'L', 'F'], // S. cerevisiae
];

const N_ROWS = MSA.length;
const N_COLS = MSA[0].length;

// Layout constants (SVG user units). The SVG scales to fit its container.
const CELL = 36;
const GAP = 6;
const ROW_LABEL_W = 150; // space reserved for "🧑 H. sapiens"-style labels
const COL_HEADER_H = 54; // space reserved for backbone dots + position numbers
const PAD_LEFT = 10;
const PAD_RIGHT = 56; // extra room on the right so column-mode arcs don't clip
const PAD_TOP = 12;
const PAD_BOTTOM = 18;

/**
 * MSAAttentionAnimator — a small widget that toggles between row-wise
 * (within-sequence) and column-wise (across-sequence) attention on an MSA.
 *
 * The design mirrors how the two operations differ in the Evoformer:
 *   - Row-wise attention (Algorithm 7): fixed sequence k, attention runs over
 *     residues i → j within that sequence. The animation highlights one row
 *     at a time and sweeps a "query" residue through it; arcs fan out from
 *     the query to every other cell in the row, showing the all-to-all
 *     pattern.
 *   - Column-wise attention (Algorithm 8): fixed residue position j, attention
 *     runs over sequences k → k' at that position. The animation highlights
 *     one column at a time and sweeps a query organism through it; arcs fan
 *     out vertically within the column.
 *
 * Controls mirror the TriMulAnimator in the same article: segmented
 * mode-switch, play/pause/step/reset, speed slider, prefers-reduced-motion.
 */
export default function MSAAttentionAnimator({
  initialMode = 'row',
}: { initialMode?: Mode } = {}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [counter, setCounter] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedMs, setSpeedMs] = useState(350); // per query step
  const [reduced, setReduced] = useState(false);

  // In row mode the outer loop is rows (5) and the inner loop is columns (10),
  // so one full cycle is 5*10 = 50 steps. In column mode it's the reverse.
  const outerMax = mode === 'row' ? N_ROWS : N_COLS;
  const innerMax = mode === 'row' ? N_COLS : N_ROWS;
  const totalSteps = outerMax * innerMax;
  const outerIdx = Math.floor(counter / innerMax) % outerMax;
  const innerIdx = counter % innerMax;

  // Reset animation when mode flips so we always start at (0, 0).
  useEffect(() => {
    setCounter(0);
  }, [mode]);

  // Respect prefers-reduced-motion: pause autoplay on first load and on
  // preference changes.
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

  // Animation loop. Advance the counter on a fixed interval; the derived
  // outer/inner indices update automatically.
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const tick = (t: number) => {
      if (cancelled) return;
      if (t - lastTickRef.current >= speedMs) {
        lastTickRef.current = t;
        setCounter((prev) => (prev + 1) % totalSteps);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speedMs, totalSteps]);

  const stepOnce = useCallback(() => {
    setPlaying(false);
    setCounter((prev) => (prev + 1) % totalSteps);
  }, [totalSteps]);

  const reset = useCallback(() => {
    setCounter(0);
    setPlaying(false);
  }, []);

  // Geometry helpers.
  const gridW = N_COLS * CELL + (N_COLS - 1) * GAP;
  const gridH = N_ROWS * CELL + (N_ROWS - 1) * GAP;
  const svgW = PAD_LEFT + ROW_LABEL_W + gridW + PAD_RIGHT;
  const svgH = PAD_TOP + COL_HEADER_H + gridH + PAD_BOTTOM;

  const cellXY = (r: number, c: number) => ({
    x: PAD_LEFT + ROW_LABEL_W + c * (CELL + GAP),
    y: PAD_TOP + COL_HEADER_H + r * (CELL + GAP),
  });
  const cellCenter = (r: number, c: number) => {
    const { x, y } = cellXY(r, c);
    return { x: x + CELL / 2, y: y + CELL / 2 };
  };

  // Active row/col (for highlighting) and the query cell (for arcs).
  const { activeRow, activeCol, queryRow, queryCol } = useMemo(() => {
    if (mode === 'row') {
      return { activeRow: outerIdx, activeCol: -1, queryRow: outerIdx, queryCol: innerIdx };
    }
    return { activeRow: -1, activeCol: outerIdx, queryRow: innerIdx, queryCol: outerIdx };
  }, [mode, outerIdx, innerIdx]);

  // Build the fan of attention arcs from the query cell to every other cell
  // in the active row/col.
  const arcs: React.ReactNode[] = [];
  if (mode === 'row') {
    // Row mode: arcs fan out horizontally, dipping *into* the cell band so
    // they don't collide with the column header or other rows. The dip is
    // small (≤ CELL/2 - 4) so residue letters remain readable.
    const r = activeRow;
    const qc = queryCol;
    const queryCenter = cellCenter(r, qc);
    for (let c = 0; c < N_COLS; c++) {
      if (c === qc) continue;
      const target = cellCenter(r, c);
      const dist = Math.abs(c - qc);
      // Arc dips downward (below the cell centers by a fraction of CELL).
      // Further-away targets get deeper arcs.
      const dip = Math.min(4 + dist * 2.2, CELL / 2 - 4);
      const midX = (queryCenter.x + target.x) / 2;
      const midY = queryCenter.y + dip;
      const d = `M ${queryCenter.x} ${queryCenter.y} Q ${midX} ${midY} ${target.x} ${target.y}`;
      arcs.push(<path key={`arc-r-${c}`} d={d} className="msa-arc" />);
    }
  } else {
    // Column mode: arcs fan out vertically, bowing to the right of the
    // active column into the right-side padding.
    const c = activeCol;
    const qr = queryRow;
    const queryCenter = cellCenter(qr, c);
    for (let r = 0; r < N_ROWS; r++) {
      if (r === qr) continue;
      const target = cellCenter(r, c);
      const dist = Math.abs(r - qr);
      const bow = Math.min(10 + dist * 6, PAD_RIGHT - 12);
      const midY = (queryCenter.y + target.y) / 2;
      const midX = queryCenter.x + CELL / 2 + bow;
      const d = `M ${queryCenter.x} ${queryCenter.y} Q ${midX} ${midY} ${target.x} ${target.y}`;
      arcs.push(<path key={`arc-c-${r}`} d={d} className="msa-arc" />);
    }
  }

  // Column-header geometry: backbone dots live on a light rule, labeled with
  // position numbers below them.
  const backboneY = PAD_TOP + COL_HEADER_H - 26;
  const colNumY = PAD_TOP + COL_HEADER_H - 10;
  const firstColCx = PAD_LEFT + ROW_LABEL_W + CELL / 2;
  const lastColCx = PAD_LEFT + ROW_LABEL_W + (N_COLS - 1) * (CELL + GAP) + CELL / 2;

  return (
    <figure className="msa-root">
      <div className="msa-controls" role="group" aria-label="Animation controls">
        <div className="msa-modeswitch" role="tablist" aria-label="Attention direction">
          <button
            role="tab"
            aria-selected={mode === 'row'}
            className={mode === 'row' ? 'msa-seg msa-seg--on' : 'msa-seg'}
            onClick={() => setMode('row')}
          >
            Row-wise <span className="msa-seg-sub">(within sequence)</span>
          </button>
          <button
            role="tab"
            aria-selected={mode === 'col'}
            className={mode === 'col' ? 'msa-seg msa-seg--on' : 'msa-seg'}
            onClick={() => setMode('col')}
          >
            Column-wise <span className="msa-seg-sub">(across sequences)</span>
          </button>
        </div>

        <div className="msa-btns">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? 'Pause animation' : 'Play animation'}
            className="msa-btn"
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" onClick={stepOnce} aria-label="Advance one step" className="msa-btn">
            Step
          </button>
          <button type="button" onClick={reset} aria-label="Reset" className="msa-btn">
            Reset
          </button>
        </div>

        <label className="msa-speed">
          <span className="msa-speed-label">Speed</span>
          <input
            type="range"
            min={120}
            max={800}
            step={20}
            value={920 - speedMs}
            onChange={(e) => setSpeedMs(920 - Number(e.currentTarget.value))}
            aria-label="Animation speed"
          />
        </label>
      </div>

      <div className="msa-viewport">
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="msa-svg"
          role="img"
          aria-label={
            mode === 'row'
              ? `Row-wise attention on sequence ${ORGANISMS[activeRow].name}, query column ${queryCol + 1}`
              : `Column-wise attention at position ${activeCol + 1}, query sequence ${ORGANISMS[queryRow].name}`
          }
        >
          {/* Active-row / active-column background band. A soft accent rect
             that sits behind the cells and extends into the label gutters, so
             it reads as "this whole axis is the scope of attention". */}
          {mode === 'row' && activeRow >= 0 && (() => {
            const { y } = cellXY(activeRow, 0);
            return (
              <rect
                x={PAD_LEFT + 4}
                y={y - 3}
                width={ROW_LABEL_W + gridW + 6}
                height={CELL + 6}
                rx={6}
                className="msa-band"
              />
            );
          })()}
          {mode === 'col' && activeCol >= 0 && (() => {
            const { x } = cellXY(0, activeCol);
            return (
              <rect
                x={x - 3}
                y={PAD_TOP + 4}
                width={CELL + 6}
                height={COL_HEADER_H + gridH + 2}
                rx={6}
                className="msa-band"
              />
            );
          })()}

          {/* Column header: backbone line + beads + numbers. The bead for the
             active column glows; others are muted. */}
          <line
            x1={firstColCx}
            y1={backboneY}
            x2={lastColCx}
            y2={backboneY}
            className="msa-backbone"
          />
          {MSA[0].map((_, c) => {
            const cx = PAD_LEFT + ROW_LABEL_W + c * (CELL + GAP) + CELL / 2;
            const isActive = mode === 'col' && c === activeCol;
            return (
              <g key={`col-header-${c}`}>
                <circle
                  cx={cx}
                  cy={backboneY}
                  r={isActive ? 5 : 3.5}
                  className={`msa-bead${isActive ? ' msa-bead--active' : ''}`}
                />
                <text
                  x={cx}
                  y={colNumY}
                  textAnchor="middle"
                  className={`msa-collabel${isActive ? ' msa-collabel--active' : ''}`}
                >
                  {c + 1}
                </text>
              </g>
            );
          })}

          {/* Row headers: emoji icon + species name on each row. */}
          {ORGANISMS.map((org, r) => {
            const y = cellXY(r, 0).y + CELL / 2;
            const isActive = mode === 'row' && r === activeRow;
            return (
              <g key={`row-header-${r}`}>
                <text
                  x={PAD_LEFT + 10}
                  y={y + 6}
                  fontSize="20"
                  className="msa-rowicon"
                >
                  {org.icon}
                </text>
                <text
                  x={PAD_LEFT + 40}
                  y={y + 5}
                  className={`msa-rowlabel${isActive ? ' msa-rowlabel--active' : ''}`}
                >
                  {org.name}
                </text>
              </g>
            );
          })}

          {/* Grid cells. Default state is muted; cells in the active row/col
             get an accent fill; the current query cell is the brightest. */}
          {MSA.map((row, r) =>
            row.map((residue, c) => {
              const { x, y } = cellXY(r, c);
              const inActive =
                (mode === 'row' && r === activeRow) ||
                (mode === 'col' && c === activeCol);
              const isQuery =
                (mode === 'row' && r === queryRow && c === queryCol) ||
                (mode === 'col' && r === queryRow && c === queryCol);
              let cls = 'msa-cell';
              if (inActive) cls += ' msa-cell--active';
              if (isQuery) cls += ' msa-cell--query';
              let textCls = 'msa-residue';
              if (inActive) textCls += ' msa-residue--active';
              if (isQuery) textCls += ' msa-residue--query';
              return (
                <g key={`cell-${r}-${c}`}>
                  <rect x={x} y={y} width={CELL} height={CELL} rx={4} className={cls} />
                  <text
                    x={x + CELL / 2}
                    y={y + CELL / 2 + 5}
                    textAnchor="middle"
                    className={textCls}
                  >
                    {residue}
                  </text>
                </g>
              );
            }),
          )}

          {/* Attention arcs fan out from the query cell to all other cells in
             the active row/col. Drawn on top of cells so they read as the
             primary action. */}
          {arcs}

          {/* Small dot highlighting the query cell center, so the eye has an
             anchor for where the arcs emanate. */}
          {(() => {
            const qc = cellCenter(queryRow, queryCol);
            return <circle cx={qc.x} cy={qc.y} r={3.2} className="msa-querydot" />;
          })()}
        </svg>
      </div>

      <figcaption className="msa-caption">
        {/* Status block. Layout is fixed: two label/value pairs in fixed
           slots. Only the value *content* changes as the animation plays;
           slot widths are locked via min-width so nothing reflows. The
           prose below is fully static — no interpolated values — so it
           never moves either. */}
        <div className="msa-status" aria-live="off">
          {mode === 'row' ? (
            <>
              <div className="msa-status-item">
                <span className="msa-status-label">Active sequence</span>
                <span className="msa-status-value msa-status-value--species">
                  <span className="msa-status-icon" aria-hidden="true">
                    {ORGANISMS[activeRow].icon}
                  </span>
                  <em>{ORGANISMS[activeRow].name}</em>
                </span>
              </div>
              <div className="msa-status-item">
                <span className="msa-status-label">Query position</span>
                <span className="msa-status-value msa-status-value--num">
                  {queryCol + 1}
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="msa-status-item">
                <span className="msa-status-label">Active position</span>
                <span className="msa-status-value msa-status-value--num">
                  {activeCol + 1}
                </span>
              </div>
              <div className="msa-status-item">
                <span className="msa-status-label">Query sequence</span>
                <span className="msa-status-value msa-status-value--species">
                  <span className="msa-status-icon" aria-hidden="true">
                    {ORGANISMS[queryRow].icon}
                  </span>
                  <em>{ORGANISMS[queryRow].name}</em>
                </span>
              </div>
            </>
          )}
        </div>
        <p className="msa-hint">
          {mode === 'row' ? (
            <>
              <strong>Row-wise attention.</strong> Within one sequence, every residue
              attends to every other residue in the same sequence — attention runs along
              the <em>amino-acid chain</em>. No information crosses between organisms in
              this step.
            </>
          ) : (
            <>
              <strong>Column-wise attention.</strong> At one aligned position, every
              organism's residue attends to the corresponding residue in every other
              organism — attention runs across the <em>organism</em> axis. This is the
              operation that asks "what does this residue look like across the family?"
            </>
          )}
          {reduced && (
            <>
              {' '}
              <span className="msa-muted">(Reduced-motion mode: use the Step button to advance.)</span>
            </>
          )}
        </p>
      </figcaption>

      <style>{`
        .msa-root {
          margin: 1.5rem 0;
          border: 1px solid var(--rule);
          border-radius: 6px;
          padding: 0.9rem 1rem 1rem;
          background: color-mix(in oklab, var(--bg) 94%, var(--rule) 6%);
          font-family: var(--font-sans);
        }
        .msa-controls {
          display: flex;
          align-items: center;
          gap: 0.9rem;
          flex-wrap: wrap;
          margin-bottom: 0.75rem;
        }
        .msa-modeswitch {
          display: inline-flex;
          border: 1px solid var(--rule);
          border-radius: 4px;
          overflow: hidden;
        }
        .msa-seg {
          border: none;
          background: transparent;
          padding: 0.35rem 0.8rem;
          font: inherit;
          font-size: 0.82rem;
          color: var(--fg-muted);
          cursor: pointer;
          border-right: 1px solid var(--rule);
          line-height: 1.15;
        }
        .msa-seg:last-child { border-right: none; }
        .msa-seg-sub {
          display: block;
          font-size: 0.7rem;
          opacity: 0.75;
          margin-top: 1px;
          font-weight: 400;
        }
        .msa-seg--on {
          background: var(--accent);
          color: white;
        }
        .msa-seg--on .msa-seg-sub { opacity: 0.85; }
        .msa-btns { display: inline-flex; gap: 0.35rem; }
        .msa-btn {
          font-size: 0.82rem;
          padding: 0.3rem 0.7rem;
          border: 1px solid var(--rule);
          border-radius: 4px;
          background: transparent;
          color: var(--fg);
          cursor: pointer;
        }
        .msa-btn:hover { border-color: var(--fg-muted); }
        .msa-speed {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          font-size: 0.78rem;
          color: var(--fg-muted);
          margin-left: auto;
        }
        .msa-speed-label { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; }
        .msa-viewport {
          display: flex;
          justify-content: center;
          overflow-x: auto;
        }
        .msa-svg {
          max-width: 100%;
          height: auto;
          min-width: 560px;
        }
        /* Active-axis band */
        .msa-band {
          fill: color-mix(in oklab, var(--accent) 10%, transparent);
          stroke: color-mix(in oklab, var(--accent) 35%, transparent);
          stroke-width: 1;
        }
        /* Column header */
        .msa-backbone {
          stroke: var(--fg-muted);
          stroke-width: 1;
          opacity: 0.35;
        }
        .msa-bead {
          fill: var(--fg-muted);
          opacity: 0.55;
          transition: r 200ms ease, fill 200ms ease, opacity 200ms ease;
        }
        .msa-bead--active {
          fill: var(--accent);
          opacity: 1;
        }
        .msa-collabel {
          font-family: var(--font-mono);
          font-size: 10.5px;
          fill: var(--fg-muted);
        }
        .msa-collabel--active {
          fill: var(--accent);
          font-weight: 700;
        }
        /* Row header */
        .msa-rowicon { user-select: none; }
        .msa-rowlabel {
          font-size: 12px;
          font-style: italic;
          fill: var(--fg-muted);
        }
        .msa-rowlabel--active {
          fill: var(--accent);
          font-weight: 700;
        }
        /* Cells */
        .msa-cell {
          fill: color-mix(in oklab, var(--rule) 50%, transparent);
          stroke: color-mix(in oklab, var(--rule) 80%, transparent);
          stroke-width: 0.5;
          transition: fill 200ms ease, stroke 200ms ease;
        }
        .msa-cell--active {
          fill: color-mix(in oklab, var(--accent) 22%, transparent);
          stroke: var(--accent);
          stroke-width: 1.1;
        }
        .msa-cell--query {
          fill: color-mix(in oklab, var(--accent) 55%, transparent);
          stroke: var(--accent);
          stroke-width: 1.6;
        }
        .msa-residue {
          font-family: var(--font-mono);
          font-size: 14px;
          fill: var(--fg-muted);
          user-select: none;
        }
        .msa-residue--active {
          fill: var(--fg);
        }
        .msa-residue--query {
          fill: var(--fg);
          font-weight: 700;
        }
        /* Attention arcs */
        .msa-arc {
          fill: none;
          stroke: var(--accent);
          stroke-width: 1.15;
          opacity: 0.55;
          pointer-events: none;
        }
        .msa-querydot {
          fill: var(--accent);
          pointer-events: none;
        }
        /* Caption */
        .msa-caption {
          margin-top: 0.9rem;
          font-size: 0.88rem;
          color: var(--fg);
        }
        /* Status block: two label/value pairs with locked-width value slots
           so the text around them never reflows during the animation. */
        .msa-status {
          display: flex;
          flex-wrap: wrap;
          gap: 0.35rem 1.75rem;
          align-items: baseline;
          padding: 0.55rem 0.75rem;
          margin-bottom: 0.65rem;
          border: 1px solid color-mix(in oklab, var(--rule) 70%, transparent);
          border-radius: 4px;
          background: color-mix(in oklab, var(--bg) 88%, var(--rule) 12%);
        }
        .msa-status-item {
          display: inline-flex;
          align-items: baseline;
          gap: 0.55rem;
          white-space: nowrap;
        }
        .msa-status-label {
          font-size: 0.68rem;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--fg-muted);
          flex-shrink: 0;
        }
        .msa-status-value {
          display: inline-flex;
          align-items: baseline;
          gap: 0.3rem;
          color: var(--fg);
          font-size: 0.92rem;
        }
        /* Species slot is wide enough to hold the longest binomial
           ("D. melanogaster") plus the emoji, so shorter names don't
           shift anything to their right. */
        .msa-status-value--species {
          min-width: 10.5rem;
        }
        /* Number slot uses tabular figures so 1-digit and 2-digit
           values occupy the same width. min-width gives a little slack. */
        .msa-status-value--num {
          min-width: 1.75rem;
          font-variant-numeric: tabular-nums;
          font-weight: 600;
        }
        .msa-status-icon {
          font-size: 1.05rem;
          line-height: 1;
          display: inline-block;
          width: 1.35rem;
          text-align: center;
        }
        .msa-status-value em { font-style: italic; color: var(--fg); }
        /* Static explanatory prose — no interpolated values, so it never
           reflows either. */
        .msa-hint {
          margin: 0;
          font-size: 0.87rem;
          line-height: 1.55;
          color: var(--fg-muted);
        }
        .msa-hint strong { color: var(--fg); }
        .msa-hint em { font-style: italic; }
        .msa-muted { font-style: italic; }
      `}</style>
    </figure>
  );
}
