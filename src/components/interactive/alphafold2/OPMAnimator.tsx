import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * OPMAnimator — step-by-step visualisation of the Outer Product Mean
 * (Algorithm 10 of the AlphaFold2 supplement). OPM is the single route by
 * which MSA information reaches the pair representation, so readers who
 * don't internalise it never quite get the Evoformer.
 *
 * The widget fixes a target residue pair (i, j) and walks through the
 * sequences of a small synthetic MSA one at a time. For each sequence k:
 *
 *   A[k, i]  (a small vector, the "left" projection at residue i)
 *   B[k, j]  (the "right" projection at residue j)
 *   →  outer product   A[k, i] ⊗ B[k, j]    (a c' × c' matrix)
 *
 * These matrices accumulate into a running mean, which the final linear
 * projection turns into a single update to z[i, j]. The running-mean cell
 * grid shows how the signal stabilises as more sequences contribute.
 *
 * The numbers are toy — a small hand-crafted MSA with c' = 4 features per
 * residue. The point isn't to show the real tensor flow but to make the
 * geometry of "per-sequence outer product, averaged across sequences"
 * physical and intuitive.
 */

// -----------------------------------------------------------------------------
// Toy MSA data. Rows are sequences, columns are residues. The actual residue
// letters are flavour; the interesting thing is the per-sequence feature
// vectors A[k, i] and B[k, j] below.
// -----------------------------------------------------------------------------

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

// Hand-crafted A and B projections. Each is N_SEQ × C_PRIME. We design them
// so early sequences have correlated (i, j) features — contributing a
// reinforcing pattern to the mean — while some later sequences contribute
// noisier patterns that wash out. This is the emergent "co-evolution
// signal survives averaging" property, rendered small.
//
// A[k] = projection of residue i in sequence k. B[k] = projection of
// residue j in sequence k.
const A: number[][] = [
  [ 0.9,  0.2,  0.1, -0.1],  // Sp1
  [ 0.8,  0.3,  0.0,  0.1],  // Sp2
  [ 0.7,  0.1,  0.2, -0.2],  // Sp3
  [ 0.9,  0.2,  0.1, -0.1],  // Sp4 (~= Sp1)
  [-0.3,  0.1,  0.6,  0.4],  // Sp5 (different)
  [ 0.8,  0.3,  0.2, -0.1],  // Sp6
];
const B: number[][] = [
  [ 0.8, -0.1,  0.2,  0.7],  // Sp1: correlated with A[Sp1] in dim 0
  [ 0.7,  0.0,  0.3,  0.6],  // Sp2
  [ 0.6, -0.1,  0.2,  0.8],  // Sp3
  [ 0.9, -0.2,  0.1,  0.5],  // Sp4
  [ 0.0,  0.4, -0.3,  0.2],  // Sp5 (decorrelated)
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

// -----------------------------------------------------------------------------
// Color scale for the matrices. Values are in roughly [-1, 1]; we map negative
// to a cool blue and positive to a warm red, with magnitude controlling
// opacity.
// -----------------------------------------------------------------------------
function cellFill(v: number): string {
  const mag = Math.min(1, Math.abs(v));
  if (v >= 0) {
    return `rgba(220, 60, 60, ${(0.15 + 0.75 * mag).toFixed(3)})`;
  }
  return `rgba(70, 130, 200, ${(0.15 + 0.75 * mag).toFixed(3)})`;
}

// Layout constants
const MSA_CELL = 22;
const MATRIX_CELL = 20;

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function OPMAnimator() {
  // `step` = the sequence index currently being added to the running mean.
  // Value 0 means "haven't added any yet"; value 1 means "added Sp1"; ...;
  // N_SEQ means "added all".
  const [step, setStep] = useState(0);
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

  // The final projected value (a scalar in our toy example). We "project"
  // by summing the mean matrix — stand-in for the Linear(c'*c' → c_z) step.
  const zUpdate = useMemo(() => {
    let s = 0;
    for (let r = 0; r < C_PRIME; r++) {
      for (let c = 0; c < C_PRIME; c++) s += mean[r][c];
    }
    return s;
  }, [mean]);

  const iDisplay = I_COL + 1;
  const jDisplay = J_COL + 1;

  return (
    <figure className="opm-root">
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

      <div className="opm-stage">
        {/* --- Top row: MSA grid --- */}
        <div className="opm-section">
          <div className="opm-section-title">
            MSA with target pair (i = {iDisplay}, j = {jDisplay})
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
          <div className="opm-section-title">
            Per-sequence step: {currentK === null
              ? <span className="opm-muted">(waiting for first sequence)</span>
              : <>sequence {MSA[currentK].species} contributes{' '}
                  <span className="opm-tensor-ref">A[{currentK + 1}, {iDisplay}]</span>
                  {' '}⊗{' '}
                  <span className="opm-tensor-ref">B[{currentK + 1}, {jDisplay}]</span>
                </>}
          </div>

          <div className="opm-current-row">
            <VectorBlock
              label={`A[k, i=${iDisplay}]`}
              vec={currentK !== null ? A[currentK] : null}
              color="red"
            />
            <div className="opm-op">⊗</div>
            <VectorBlock
              label={`B[k, j=${jDisplay}]`}
              vec={currentK !== null ? B[currentK] : null}
              color="blue"
            />
            <div className="opm-op">=</div>
            <MatrixBlock
              label="outer product (c' × c')"
              mat={currentK !== null ? OUTERS[currentK] : null}
              highlight
            />
          </div>
        </div>

        {/* --- Bottom row: running mean + final z update --- */}
        <div className="opm-section">
          <div className="opm-section-title">
            Running mean across sequences contributed so far
          </div>
          <div className="opm-bottom-row">
            <MatrixBlock
              label={`mean over k=1..${step}`}
              mat={step > 0 ? mean : null}
            />
            <div className="opm-op opm-op--arrow">→ Linear →</div>
            <div className="opm-zcell">
              <div className="opm-zcell-label">z[{iDisplay}, {jDisplay}] update</div>
              <div
                className="opm-zcell-value"
                style={{ background: step > 0 ? cellFill(zUpdate * 0.6) : 'transparent' }}
              >
                {step > 0 ? zUpdate.toFixed(2) : '—'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <figcaption className="opm-caption">
        <div>
          <strong>Outer product mean.</strong> For a fixed pair (i, j), every sequence k contributes
          a <em>c' × c'</em> outer product of its own feature vectors A[k, i] and B[k, j]. The
          running mean across sequences is then projected to the pair-representation dimension and
          added into z[i, j]. Watch the mean matrix <em>stabilize</em> as each new sequence is
          added: patterns shared across rows reinforce; idiosyncratic patterns wash out. That's why
          the OPM recovers consensus co-evolution signal rather than the quirks of any single
          aligned sequence.
        </div>
        {reduced && (
          <div className="opm-reduced-note">
            Reduced-motion mode: use Step to advance one sequence at a time.
          </div>
        )}
      </figcaption>

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
          display: flex;
          flex-direction: column;
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
        .opm-msa-col-header.opm-col-i { color: rgba(220, 60, 60, 1); font-weight: 700; }
        .opm-msa-col-header.opm-col-j { color: rgba(70, 130, 200, 1); font-weight: 700; }
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
        .opm-msa-cell.opm-col-i { background: rgba(220, 60, 60, 0.18); color: var(--fg); }
        .opm-msa-cell.opm-col-j { background: rgba(70, 130, 200, 0.18); color: var(--fg); }
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
        .opm-section--current { min-height: 140px; }
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
}: {
  label: string;
  vec: number[] | null;
  color: 'red' | 'blue';
}) {
  const tint = color === 'red' ? 'rgba(220, 60, 60,' : 'rgba(70, 130, 200,';
  return (
    <div className="opm-vec">
      <div className="opm-vec-cells">
        {vec === null
          ? Array.from({ length: C_PRIME }).map((_, idx) => (
              <div key={`v-e-${idx}`} className="opm-vec-cell opm-vec-cell--empty" />
            ))
          : vec.map((v, idx) => {
              const mag = Math.min(1, Math.abs(v));
              const opacity = (0.2 + 0.7 * mag).toFixed(3);
              const bg = v >= 0 ? `${tint} ${opacity})` : 'rgba(180, 180, 180, 0.18)';
              return (
                <div
                  key={`v-${idx}`}
                  className="opm-vec-cell"
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
          width: ${MATRIX_CELL}px;
          height: ${MATRIX_CELL}px;
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
}: {
  label: string;
  mat: number[][] | null;
  highlight?: boolean;
}) {
  return (
    <div className={`opm-mat${highlight ? ' opm-mat--highlight' : ''}`}>
      <div className="opm-mat-cells">
        {Array.from({ length: C_PRIME }).map((_, r) => (
          <div key={`mat-r-${r}`} className="opm-mat-row">
            {Array.from({ length: C_PRIME }).map((_, c) => {
              const v = mat ? mat[r][c] : null;
              return (
                <div
                  key={`mat-c-${r}-${c}`}
                  className={`opm-mat-cell${v === null ? ' opm-mat-cell--empty' : ''}`}
                  style={v === null ? undefined : { background: cellFill(v) }}
                  title={v === null ? '—' : v.toFixed(2)}
                />
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
        .opm-mat-cell {
          width: ${MATRIX_CELL}px;
          height: ${MATRIX_CELL}px;
          border: 1px solid color-mix(in oklab, var(--rule) 50%, transparent);
          border-radius: 2px;
          background: color-mix(in oklab, var(--rule) 15%, transparent);
        }
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
