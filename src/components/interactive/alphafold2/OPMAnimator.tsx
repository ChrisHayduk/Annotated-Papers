import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Linked views of Algorithm 10: each sequence's outer product enters a
 * running mean, then a learned output projection updates pair features.
 * The feature values below are illustrative, not trained weights.
 */

const MSA = [
  // 6 sequences × 8 residues
  { species: 'Sp1', seq: 'GDVEKGKK' },
  { species: 'Sp2', seq: 'GDVEKGKK' },
  { species: 'Sp3', seq: 'GDIEKGKK' },
  { species: 'Sp4', seq: 'GDVEKGKR' },
  { species: 'Sp5', seq: 'GSAKKGAT' },
  { species: 'Sp6', seq: 'GAVAKGKR' },
];
const N_SEQ = MSA.length;
const N_RES = 8;

// The operation we're illustrating.
const I_COL = 2; // target position i (0-indexed) — display as residue i+1 = 3
const J_COL = 6; // target position j (0-indexed) — display as residue j+1 = 7

const C_PRIME = 4; // feature dimension (c'). Small, so the outer products
//                    fit visibly on screen.

// Hand-crafted projected features for the fixed target pair.
const A: number[][] = [
  [ 0.9,  0.2,  0.1, -0.1],  // Sp1
  [ 0.8,  0.3,  0.0,  0.1],  // Sp2
  [ 0.7,  0.1,  0.2, -0.2],  // Sp3
  [ 0.9,  0.2,  0.1, -0.1],  // Sp4 (~= Sp1)
  [-0.3,  0.1,  0.6,  0.4],  // Sp5 (different)
  [ 0.8,  0.3,  0.2, -0.1],  // Sp6
];
const B: number[][] = [
  [ 0.8, -0.1,  0.2,  0.7],  // Sp1
  [ 0.7,  0.0,  0.3,  0.6],  // Sp2
  [ 0.6, -0.1,  0.2,  0.8],  // Sp3
  [ 0.9, -0.2,  0.1,  0.5],  // Sp4
  [ 0.0,  0.4, -0.3,  0.2],  // Sp5
  [ 0.8, -0.1,  0.3,  0.6],  // Sp6
];

// Compute outer products up front.
function outer(a: number[], b: number[]): number[][] {
  const m = a.length;
  const n = b.length;
  const out: number[][] = [];
  for (let r = 0; r < m; r++) {
    const row: number[] = [];
    for (let c = 0; c < n; c++) row.push(a[r] * b[c]);
    out.push(row);
  }
  return out;
}
const OUTERS: number[][][] = MSA.map((_, k) => outer(A[k], B[k]));

// Cumulative average: running mean of OUTERS[0..k].
function runningMean(upTo: number): number[][] {
  if (upTo < 0) {
    return Array.from({ length: C_PRIME }, () => Array(C_PRIME).fill(0));
  }
  const acc = Array.from({ length: C_PRIME }, () => Array(C_PRIME).fill(0));
  for (let k = 0; k <= upTo; k++) {
    for (let r = 0; r < C_PRIME; r++) {
      for (let c = 0; c < C_PRIME; c++) {
        acc[r][c] += OUTERS[k][r][c];
      }
    }
  }
  const n = upTo + 1;
  return acc.map((row) => row.map((v) => v / n));
}

// Fixed illustrative 16 → 4 linear map (zero bias), never trained weights.
// Flatten in row-major order. Channel sign patterns: all positive;
// alternating -/+ columns; negative top / positive bottom; checkerboard.
const PROJECTION_WEIGHTS = Array.from({ length: 4 }, (_, channel) =>
  Array.from({ length: C_PRIME * C_PRIME }, (_, index) => {
    const row = Math.floor(index / C_PRIME);
    const col = index % C_PRIME;
    const sign = channel === 0 ? 1
      : channel === 1 ? (col % 2 === 0 ? -1 : 1)
      : channel === 2 ? (row < 2 ? -1 : 1)
      : ((row + col) % 2 === 0 ? 1 : -1);
    return sign * 0.5;
  }),
);
function projectMean(mean: number[][]): number[] {
  const features = mean.flat();
  return PROJECTION_WEIGHTS.map((weights) =>
    weights.reduce((sum, weight, index) => sum + weight * features[index], 0),
  );
}
const signed = (value: number) => {
  const rounded = Math.round((Math.abs(value) + Number.EPSILON) * 1000) / 1000;
  return `${rounded === 0 ? '' : value < 0 ? '−' : '+'}${rounded.toFixed(3)}`;
};

// The sign remains visible in the numbers; color reinforces it.
function cellFill(value: number): string {
  return `color-mix(in oklab, var(${value < 0 ? '--data-msa' : '--accent'}) ${10 + Math.min(1, Math.abs(value)) * 38}%, var(--surface-strong))`;
}

// Layout constants
const MSA_CELL = 22;
const MATRIX_CELL = 44;

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function OPMAnimator() {
  // `step` = the sequence index currently being added to the running mean.
  // Value 0 means "haven't added any yet"; value 1 means "added Sp1"; ...;
  // N_SEQ means "added all".
  const [step, setStep] = useState(1);
  const [selectedCell, setSelectedCell] = useState({ row: 0, col: 0 });
  const [playing, setPlaying] = useState(true);
  const [speedMs, setSpeedMs] = useState(1200);
  const [reduced, setReduced] = useState(false);

  // prefers-reduced-motion
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

  // Animation loop. Advances `step` by 1 every speedMs, wraps to 0 after
  // reaching N_SEQ (so the reset shows "before any sequence contributes").
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
        setStep((prev) => (prev >= N_SEQ ? 0 : prev + 1));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speedMs]);

  const stepOnce = useCallback(() => {
    setPlaying(false);
    setStep((prev) => (prev >= N_SEQ ? 0 : prev + 1));
  }, []);
  const reset = useCallback(() => {
    setStep(0);
    setPlaying(false);
  }, []);

  // The current "live" sequence (the one whose outer product just joined
  // the mean). If step === 0, none yet.
  const currentK = step === 0 ? null : step - 1;
  const mean = useMemo(() => runningMean(currentK ?? -1), [currentK]);
  const projected = useMemo(() => projectMean(mean), [mean]);

  const selectSequence = (count: number) => { setStep(count); setPlaying(false); };
  const selectCell = (row: number, col: number) => { setSelectedCell({ row, col }); setPlaying(false); };

  const iDisplay = I_COL + 1;
  const jDisplay = J_COL + 1;

  return (
    <figure className="opm-root">
      <figcaption className="opm-heading"><strong>Outer product mean</strong><span>Select a sequence or feature cell to follow its contribution.</span></figcaption>
      <div className="opm-controls">
        <div className="opm-btns">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="opm-btn"
            aria-label={playing ? 'Pause animation' : 'Play animation'}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" onClick={stepOnce} className="opm-btn" aria-label="Step">
            Step
          </button>
          <button type="button" onClick={reset} className="opm-btn" aria-label="Reset">
            Reset
          </button>
        </div>
        <div className="opm-progress">
          <span className="opm-progress-label">Sequences contributed</span>
          <span className="opm-progress-value">{step} / {N_SEQ}</span>
        </div>
        <label className="opm-speed">
          <span className="opm-speed-label">Speed</span>
          <input
            type="range"
            min={350}
            max={2000}
            step={50}
            value={2350 - speedMs}
            onChange={(e) => setSpeedMs(2350 - Number(e.currentTarget.value))}
            aria-label="Animation speed"
          />
        </label>
      </div>

      <label className="opm-scrub">Sequences in the mean <strong>{step} / {N_SEQ}</strong><input type="range" aria-label="Sequences in the mean" min={0} max={N_SEQ} step={1} value={step} onChange={(event) => selectSequence(Number(event.target.value))} /></label>

      <div className="opm-stage">
        {/* --- Top row: MSA grid --- */}
        <div className="opm-section">
          <div className="opm-section-title">
            <span className="opm-panel-index">01</span> Alignment · positions {iDisplay} and {jDisplay}
          </div>
          <div className="opm-msa">
            <div className="opm-msa-header">
              <div className="opm-msa-label-col">&nbsp;</div>
              {Array.from({ length: N_RES }).map((_, c) => (
                <div
                  key={`msa-h-${c}`}
                  className={`opm-msa-col-header${c === I_COL ? ' opm-col-i' : ''}${c === J_COL ? ' opm-col-j' : ''}`}
                >
                  {c + 1}
                </div>
              ))}
            </div>
            {MSA.map((row, k) => {
              const isCurrent = currentK === k;
              const hasContributed = currentK !== null && k <= currentK;
              return (
                <div
                  key={`msa-row-${k}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Inspect sequence ${k + 1}; average the first ${k + 1} sequences`}
                  aria-pressed={isCurrent}
                  onClick={() => selectSequence(k + 1)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSequence(k + 1); } }}
                  className={`opm-msa-row${isCurrent ? ' opm-msa-row--current' : ''}${hasContributed ? ' opm-msa-row--done' : ''}`}
                >
                  <div className="opm-msa-label-col">{row.species}</div>
                  {row.seq.split('').map((aa, c) => {
                    const isI = c === I_COL;
                    const isJ = c === J_COL;
                    return (
                      <div
                        key={`msa-${k}-${c}`}
                        className={`opm-msa-cell${isI ? ' opm-col-i' : ''}${isJ ? ' opm-col-j' : ''}`}
                      >
                        {aa}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* --- Middle row: current-k projections + outer product --- */}
        <div className="opm-section opm-section--current">
          <div className="opm-section-title"><span className="opm-panel-index">02</span> {currentK === null ? 'Per-sequence outer product' : `Outer product · sequence ${currentK + 1}`}</div>

          <div className="opm-current-row">
            <div className="opm-input-vectors">
            <VectorBlock
              label={`A[k, i=${iDisplay}]`}
              vec={currentK !== null ? A[currentK] : null}
              color="red"
              selectedChannel={selectedCell.row}
            />
            <div className="opm-op">⊗</div>
            <VectorBlock
              label={`B[k, j=${jDisplay}]`}
              vec={currentK !== null ? B[currentK] : null}
              color="blue"
              selectedChannel={selectedCell.col}
            />
            </div>
            <div className="opm-op opm-flow-down" aria-hidden="true">↓</div>
            <MatrixBlock
              label="4 × 4 feature products"
              mat={currentK !== null ? OUTERS[currentK] : null}
              highlight
              selectedCell={selectedCell}
              onSelect={selectCell}
            />
          </div>
        </div>

        {/* --- Bottom row: running mean + final z update --- */}
        <div className="opm-section">
          <div className="opm-section-title">
            <span className="opm-panel-index">03</span> Mean → pair update
          </div>
          <div className="opm-bottom-row">
            <MatrixBlock
              label={step ? `Mean of sequences 1–${step}` : 'No contributions yet'}
              mat={step > 0 ? mean : null}
              selectedCell={selectedCell}
              onSelect={selectCell}
              decimals={3}
            />
            <div className="opm-projection"><span aria-hidden="true">↓</span><span>Flatten 16 features<br />Example linear projection · 4 channels</span><span aria-hidden="true">↓</span></div>
            <div className="opm-zcell">
              <div className="opm-output-bars" aria-label="Example projected pair update">
                {projected.map((value, channel) => (
                  <div className="opm-output-row" key={channel} aria-label={`Output channel ${channel}: ${signed(value)}`}>
                    <span>c{channel}</span>
                    <div className="opm-output-track" aria-hidden="true"><i style={{ left: `${value < 0 ? 50 - Math.abs(value) * 50 : 50}%`, width: `${Math.abs(value) * 50}%`, background: `var(${value < 0 ? '--data-msa' : '--accent'})` }} /></div>
                    <span className="opm-output-number">{signed(value)}</span>
                  </div>
                ))}
              </div>
              <span>Δz[{iDisplay}, {jDisplay}] · example pair update</span>
            </div>
          </div>
        </div>
      </div>

      <div className="opm-linked-readout"><span>Feature cell ({selectedCell.row}, {selectedCell.col})</span>{currentK === null ? <strong>No sequence included</strong> : <><strong>{A[currentK][selectedCell.row].toFixed(1)} × {B[currentK][selectedCell.col].toFixed(1)} = {OUTERS[currentK][selectedCell.row][selectedCell.col].toFixed(2)}</strong><span>Mean: <strong>{mean[selectedCell.row][selectedCell.col].toFixed(3)}</strong></span></>}</div>
      <details className="opm-detail"><summary>Inspect the arithmetic and output shape</summary><p>Each sequence contributes A[k, {iDisplay}] ⊗ B[k, {jDisplay}], a 4 × 4 grid. The highlighted cell combines A channel {selectedCell.row} with B channel {selectedCell.col}. {step > 0 && <>Its current mean is ({OUTERS.slice(0, step).map((matrix) => matrix[selectedCell.row][selectedCell.col].toFixed(2)).join(' + ').replaceAll('+ -', '− ')}) ÷ {step} ≈ {mean[selectedCell.row][selectedCell.col].toFixed(3)}.</>}</p><p>The demo flattens the 16 mean values row by row and projects them into four example output channels. Every weight has magnitude ½ and the bias is zero. Channel 0 uses all positive weights; channel 1 alternates −/+ across columns; channel 2 uses − for the first two rows and + for the last two; channel 3 uses a +/− checkerboard starting with + at (0, 0). Each bar shows one weighted sum on the same −1 to +1 scale.</p><p>These weights are illustrative, not trained AlphaFold weights. AlphaFold learns a projection into c<sub>z</sub> channels and adds it to z. All six rows here are valid; real inputs mask invalid positions. The feature products and outputs are not contact probabilities or centered covariances.</p></details>
      {reduced && <p className="opm-reduced-note">Reduced motion is on. Use Step or select a sequence, or press Play to animate.</p>}

      <style>{`
        .opm-root {
          margin: 1.5rem 0;
          border: 1px solid var(--rule);
          border-radius: 6px;
          padding: 0.95rem 1rem 1rem;
          background: color-mix(in oklab, var(--bg) 94%, var(--rule) 6%);
          font-family: var(--font-sans);
        }
        .opm-controls {
          display: flex;
          align-items: center;
          gap: 1rem;
          flex-wrap: wrap;
          margin-bottom: 0.85rem;
        }
        .opm-btns { display: inline-flex; gap: 0.35rem; }
        .opm-btn {
          font-size: 0.82rem;
          padding: 0.3rem 0.7rem;
          border: 1px solid var(--rule);
          border-radius: 4px;
          background: transparent;
          color: var(--fg);
          cursor: pointer;
        }
        .opm-btn:hover { border-color: var(--fg-muted); }
        .opm-progress {
          display: inline-flex;
          align-items: baseline;
          gap: 0.55rem;
          font-family: var(--font-mono);
        }
        .opm-progress-label {
          font-size: 0.7rem;
          color: var(--fg-muted);
          letter-spacing: 0.07em;
          text-transform: uppercase;
        }
        .opm-progress-value {
          font-size: 0.9rem;
          color: var(--fg);
          font-weight: 600;
          min-width: 2.8rem;
          display: inline-block;
          font-variant-numeric: tabular-nums;
        }
        .opm-speed {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          font-size: 0.78rem;
          color: var(--fg-muted);
          margin-left: auto;
        }
        .opm-speed-label { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; }

        /* The staged layout */
        .opm-stage {
          display: grid;
          grid-template-columns: 1fr;
          gap: 0.9rem;
        }
        .opm-section-title {
          font-size: 0.78rem;
          color: var(--fg-muted);
          letter-spacing: 0.05em;
          margin-bottom: 0.4rem;
        }
        .opm-section-title strong { color: var(--fg); }
        .opm-muted { font-style: italic; color: var(--fg-muted); opacity: 0.8; }
        .opm-tensor-ref {
          font-family: var(--font-mono);
          font-size: 0.84em;
          color: var(--fg);
          background: color-mix(in oklab, var(--rule) 25%, transparent);
          padding: 0 4px;
          border-radius: 2px;
        }

        /* MSA grid */
        .opm-msa {
          display: inline-flex;
          flex-direction: column;
          border: 1px solid var(--rule);
          border-radius: 4px;
          padding: 6px;
          background: color-mix(in oklab, var(--bg) 90%, var(--rule) 10%);
          font-family: var(--font-mono);
          font-size: 13px;
        }
        .opm-msa-header, .opm-msa-row {
          display: grid;
          grid-template-columns: 38px repeat(${N_RES}, ${MSA_CELL}px);
          gap: 2px;
          align-items: center;
        }
        .opm-msa-col-header {
          font-size: 10px;
          color: var(--fg-muted);
          text-align: center;
          font-family: var(--font-mono);
        }
        .opm-msa-col-header.opm-col-i { color: var(--accent); font-weight: 700; }
        .opm-msa-col-header.opm-col-j { color: var(--data-msa); font-weight: 700; }
        .opm-msa-label-col {
          font-size: 11px;
          color: var(--fg-muted);
          font-family: var(--font-sans);
          text-align: right;
          padding-right: 4px;
        }
        .opm-msa-cell {
          width: ${MSA_CELL}px;
          height: ${MSA_CELL}px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--fg);
          background: color-mix(in oklab, var(--rule) 40%, transparent);
          border-radius: 3px;
          transition: background 180ms ease;
        }
        .opm-msa-cell.opm-col-i { background: var(--accent-soft); color: var(--fg); }
        .opm-msa-cell.opm-col-j { background: color-mix(in oklab,var(--data-msa) 18%,var(--bg)); color: var(--fg); }
        .opm-msa-row--current .opm-msa-cell {
          outline: 1px solid color-mix(in oklab, var(--accent) 70%, transparent);
        }
        .opm-msa-row--current .opm-msa-label-col {
          color: var(--accent);
          font-weight: 600;
        }
        .opm-msa-row--done .opm-msa-label-col {
          color: var(--fg);
        }

        /* Middle section: vectors + outer product */
        .opm-section--current { min-height: 0; }
        .opm-current-row {
          display: flex;
          align-items: center;
          gap: 0.8rem;
          flex-wrap: wrap;
        }
        .opm-op {
          font-size: 1.3rem;
          color: var(--fg-muted);
          font-weight: 500;
          padding: 0 0.25rem;
        }
        .opm-op--arrow {
          font-size: 0.85rem;
          font-family: var(--font-mono);
          padding: 0 0.5rem;
        }

        /* Bottom row: running mean + z update */
        .opm-bottom-row {
          display: flex;
          align-items: center;
          gap: 0.8rem;
          flex-wrap: wrap;
        }
        .opm-zcell {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.35rem;
          min-width: 100px;
        }
        .opm-zcell-label {
          font-size: 0.7rem;
          color: var(--fg-muted);
          letter-spacing: 0.05em;
          font-family: var(--font-mono);
        }
        .opm-zcell-value {
          width: 64px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--rule);
          border-radius: 4px;
          font-family: var(--font-mono);
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--fg);
          transition: background 250ms ease;
          font-variant-numeric: tabular-nums;
        }

        /* Caption */
        .opm-caption {
          margin-top: 0.85rem;
          font-size: 0.87rem;
          line-height: 1.55;
          color: var(--fg-muted);
        }
        .opm-caption strong { color: var(--fg); }
        .opm-caption em { font-style: italic; color: var(--fg); }
        .opm-reduced-note {
          font-style: italic;
          margin-top: 0.3rem;
        }

        .opm-root { container-type:inline-size; background:var(--surface-strong); border-radius:.6rem; }
        .opm-heading { display:flex; justify-content:space-between; flex-wrap:wrap; align-items:baseline; gap:.35rem 1rem; margin:0 0 1rem; color:var(--fg); }.opm-heading strong { font:600 1rem/1.4 var(--font-sans); }.opm-heading span { color:var(--fg-muted); font-size:.76rem; }.opm-root .opm-btn { min-height:36px; }.opm-btn:first-child { background:var(--accent); color:var(--bg); border-color:var(--accent); }
        .opm-scrub { display:grid; grid-template-columns:1fr auto; gap:.35rem; font-size:.7rem; color:var(--fg-muted); margin:.75rem 0 1rem; }.opm-scrub strong { color:var(--accent); font-family:var(--font-mono); }.opm-scrub input { grid-column:1 / -1; width:100%; accent-color:var(--accent); }.opm-speed input { width:105px; accent-color:var(--accent); }
        .opm-stage>.opm-section { min-width:0; padding:.75rem .65rem; border:1px solid var(--rule); border-radius:.45rem; background:var(--bg); }.opm-section-title { font-size:.68rem; letter-spacing:0; line-height:1.5; text-transform:none; min-height:1.1rem; margin-bottom:.85rem; color:var(--fg); }.opm-panel-index { color:var(--accent); font-family:var(--font-mono); margin-right:.35rem; }.opm-stage>.opm-section:first-child { display:flex; flex-direction:column; align-items:center; }.opm-section:first-child>.opm-section-title { align-self:stretch; }.opm-msa { max-width:100%; overflow:auto; }.opm-msa-row { padding:2px 0; cursor:pointer; border-radius:3px; }.opm-msa-row:hover { background:var(--accent-soft); }.opm-msa-row--current { background:var(--accent-soft); }.opm-msa-row--current .opm-msa-cell { outline:0; }.opm-msa-row--current .opm-col-i { box-shadow:inset 0 0 0 2px var(--accent); }.opm-msa-row--current .opm-col-j { box-shadow:inset 0 0 0 2px var(--data-msa); }
        .opm-current-row,.opm-bottom-row { flex-direction:column; justify-content:center; gap:.5rem; }.opm-input-vectors { display:flex; align-items:center; gap:.3rem; }.opm-input-vectors>.opm-op { padding:0 .1rem; font-size:1.1rem; }.opm-projection { display:grid; gap:.15rem; justify-items:center; color:var(--fg-muted); font-size:.62rem; line-height:1.5; text-align:center; }.opm-projection>span:not(:nth-child(2)) { color:var(--accent); font-size:1rem; }.opm-output-bars { display:grid; gap:.3rem; width:196px; max-width:100%; }.opm-output-row { display:grid; grid-template-columns:20px minmax(60px,1fr) 49px; align-items:center; gap:5px; font:500 10.5px var(--font-mono); color:var(--fg-muted); }.opm-output-track { height:13px; position:relative; background:var(--surface); border-radius:2px; }.opm-output-track::after { content:""; position:absolute; top:-2px; bottom:-2px; left:50%; width:1px; background:var(--rule); }.opm-output-track i { display:block; position:absolute; top:1px; height:11px; border-radius:2px; transition:left 250ms ease,width 250ms ease,background 250ms ease; }.opm-output-number { color:var(--fg); text-align:right; font-variant-numeric:tabular-nums; }.opm-zcell>span { font-size:.64rem; color:var(--accent); }.opm-flow-down { color:var(--accent); font-size:1rem; }
        .opm-linked-readout { display:flex; align-items:baseline; flex-wrap:wrap; gap:.4rem 1rem; margin-top:1rem; padding:.6rem .8rem; border:1px solid var(--rule); background:var(--surface); border-radius:.35rem; font:.75rem/1.6 var(--font-mono); color:var(--fg-muted); }.opm-linked-readout>strong,.opm-linked-readout span strong { color:var(--fg); }.opm-linked-readout>span:first-child { font:500 .69rem var(--font-sans); }.opm-detail { margin-top:.7rem; border-top:1px solid var(--rule); padding-top:.6rem; font-size:.74rem; color:var(--fg-muted); }.opm-detail summary { cursor:pointer; color:var(--accent); }.opm-root .opm-detail p { margin:.5rem 0 0; line-height:1.7; }.opm-progress { margin-left:auto; }.opm-progress-label { font-size:.61rem; letter-spacing:0; }.opm-progress-value { font-size:.78rem; }.opm-speed-label { font-size:.62rem; letter-spacing:0; text-transform:none; }
        @media(prefers-reduced-motion:reduce) { .opm-output-track i { transition:none; } }
        @container(min-width:740px) { .opm-stage { grid-template-columns:1.1fr 1fr 1fr; gap:.6rem; } }
        @container(max-width:739px) and (min-width:480px) { .opm-stage { grid-template-columns:1fr 1fr; }.opm-stage>.opm-section:first-child { grid-row:1 / 3; justify-content:center; }.opm-stage>.opm-section:first-child .opm-section-title { margin-top:0; }.opm-input-vectors { flex-wrap:wrap; justify-content:center; }.opm-section--current { grid-column:2; } }
        @media(max-width:520px) { .opm-root { padding:.85rem; }.opm-controls { gap:.6rem; }.opm-progress { margin-left:0; }.opm-speed { margin-left:0; }.opm-heading span { font-size:.72rem; }.opm-stage>.opm-section { padding:.75rem .45rem; }.opm-linked-readout { gap:.3rem .7rem; font-size:.72rem; } }
      `}</style>
    </figure>
  );
}

// -----------------------------------------------------------------------------
// Vector display: row of small colored cells
// -----------------------------------------------------------------------------

function VectorBlock({
  label,
  vec,
  color,
  selectedChannel,
}: {
  label: string;
  vec: number[] | null;
  color: 'red' | 'blue';
  selectedChannel: number;
}) {
  const tone = color === 'red' ? '--accent' : '--data-msa';
  return (
    <div className="opm-vec">
      <div className="opm-vec-cells">
        {vec === null
          ? Array.from({ length: C_PRIME }).map((_, idx) => (
              <div key={`v-e-${idx}`} className="opm-vec-cell opm-vec-cell--empty" />
            ))
          : vec.map((v, idx) => {
              const bg = `color-mix(in oklab,var(${tone}) ${10 + Math.min(1, Math.abs(v)) * 32}%,var(--surface-strong))`;
              return (
                <div
                  key={`v-${idx}`}
                  className={`opm-vec-cell${selectedChannel === idx ? ' opm-vec-cell--selected' : ''}`}
                  style={{ background: bg }}
                  title={v.toFixed(2)}
                >
                  {v.toFixed(1)}
                </div>
              );
            })}
      </div>
      <div className="opm-vec-label">{label}</div>
      <style>{`
        .opm-vec {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.25rem;
        }
        .opm-vec-cells {
          display: flex;
          gap: 2px;
        }
        .opm-vec-cell {
          width: 24px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid color-mix(in oklab, var(--rule) 60%, transparent);
          border-radius: 2px;
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--fg);
          font-variant-numeric: tabular-nums;
          background: color-mix(in oklab, var(--rule) 20%, transparent);
        }
        .opm-vec-cell--selected { outline:2px solid var(${tone}); outline-offset:1px; position:relative; z-index:1; }
        .opm-vec-cell--empty {
          background: color-mix(in oklab, var(--rule) 10%, transparent);
          border-style: dashed;
        }
        .opm-vec-label {
          font-family: var(--font-mono);
          font-size: 10.5px;
          color: var(--fg-muted);
        }
      `}</style>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Matrix display: grid of colored cells (no numbers — magnitude via color)
// -----------------------------------------------------------------------------

function MatrixBlock({
  label,
  mat,
  highlight = false,
  selectedCell,
  onSelect,
  decimals = 2,
}: {
  label: string;
  mat: number[][] | null;
  highlight?: boolean;
  selectedCell: {row:number;col:number};
  onSelect: (row:number,col:number) => void;
  decimals?: number;
}) {
  return (
    <div className={`opm-mat${highlight ? ' opm-mat--highlight' : ''}`}>
      <div className="opm-mat-cells">
        {Array.from({ length: C_PRIME }).map((_, r) => (
          <div key={`mat-r-${r}`} className="opm-mat-row">
            {Array.from({ length: C_PRIME }).map((_, c) => {
              const v = mat ? mat[r][c] : null;
              return (
                <button
                  type="button"
                  key={`mat-c-${r}-${c}`}
                  className={`opm-mat-cell${v === null ? ' opm-mat-cell--empty' : ''}${selectedCell.row === r && selectedCell.col === c ? ' opm-mat-cell--selected' : ''}`}
                  aria-label={`${label}: A channel ${r}, B channel ${c}, ${v === null ? 'no value yet' : v.toFixed(decimals)}`}
                  aria-pressed={selectedCell.row === r && selectedCell.col === c}
                  onClick={() => onSelect(r, c)}
                  style={v === null ? undefined : { background: cellFill(v) }}
                  title={v === null ? '—' : v.toFixed(decimals)}
                >{v === null ? '·' : v.toFixed(decimals)}</button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="opm-mat-label">{label}</div>
      <style>{`
        .opm-mat {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.25rem;
          padding: 3px;
          border-radius: 3px;
        }
        .opm-mat--highlight {
          outline: 1px dashed color-mix(in oklab, var(--accent) 60%, transparent);
        }
        .opm-mat-cells {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .opm-mat-row {
          display: flex;
          gap: 1px;
        }
        .opm-root .opm-mat-cell {
          width: ${MATRIX_CELL}px;
          height: ${MATRIX_CELL}px;
          min-height:0;
          padding:0;
          cursor:pointer;
          color:var(--fg);
          font:500 10.5px var(--font-mono);
          transition:background 180ms ease;
          border: 1px solid color-mix(in oklab, var(--rule) 50%, transparent);
          border-radius: 2px;
          background: color-mix(in oklab, var(--rule) 15%, transparent);
        }
        .opm-root .opm-mat-cell--selected { outline:2px solid var(--accent); outline-offset:1px; position:relative; z-index:1; }
        .opm-mat-cell--empty {
          border-style: dashed;
          background: transparent;
        }
        .opm-mat-label {
          font-family: var(--font-mono);
          font-size: 10.5px;
          color: var(--fg-muted);
          margin-top: 2px;
        }
      `}</style>
    </div>
  );
}
