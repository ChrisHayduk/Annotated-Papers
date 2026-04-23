import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * CoevolutionViewer — three linked panels that demonstrate the founding
 * insight of AlphaFold2: MSA columns that co-vary correspond to residues
 * that are in 3D contact.
 *
 *   Panel A (top-left):  MSA grid, scrollable. Columns i and j highlight.
 *   Panel B (top-right): N×N heatmap in contact-prediction-evaluation
 *                        format. Upper-right triangle shows the top-L
 *                        coupling predictions (red if they land on a true
 *                        contact, pale red if false-positive); lower-left
 *                        triangle shows real 3D contacts shaded by
 *                        Cα–Cα distance. Selected (i, j) cell flashes on
 *                        both halves.
 *   Panel C (bottom):    3Dmol.js cartoon of the reference structure.
 *                        Selected residues appear as highlighted spheres
 *                        joined by a dashed line labelled with the
 *                        Cα–Cα distance.
 *
 * Data comes from /co-evolution/trypsin.json (built by
 * scripts/build_coevolution_demo.py from ~2000 Pfam-PF00089 homologs
 * aligned with MAFFT, mapped to 2PTN bovine β-trypsin).
 *
 * Preset buttons pick a handful of canonical (i, j) pairs — high coupling +
 * contact, high coupling + distant, low coupling + contact — so readers who
 * don't want to click around still see the pattern.
 */

interface Sequence {
  accession: string;
  species: string;
  common: string;
  aligned: string;
}
interface CoevolData {
  protein: string;
  reference: { accession: string; name: string; pdb_id: string };
  length: number;
  sequences: Sequence[];
  coupling: number[][];
  distance: (number | null)[][];
  pdb: string;
  contact_threshold_A: number;
  min_separation: number;
  // [[i, j, score], ...] — top-L pairs ranked by coupling / distance, using
  // 1-indexed alignment column numbers
  top_coupling_pairs: Array<[number, number, number]>;
  top_contact_pairs: Array<[number, number, number]>;
  top_n: number;
  top_coupling_precision: number;
  // Alignment column (1-indexed) → PDB residue number in the reference
  // chain. The alignment is 1..N columns long; PDB numbering may start
  // at some other number and skip missing residues.
  column_pdb_residues: number[];
}

const DATA_URL = '/co-evolution/trypsin.json';

async function load3Dmol() {
  return import('3dmol/build/3Dmol.es6-min.js');
}

// Presets picked from the top-L coupling list. `i` and `j` are 1-indexed
// alignment columns; `label` / `subtitle` describe the pair using the
// PDB's residue numbering (which is what anyone reading a DCA or
// structural-biology paper on trypsin will be using).
const PRESETS: Array<{
  label: string;
  subtitle: string;
  i: number;
  j: number;
}> = [
  {
    label: 'Cys136–Cys201 disulfide',
    subtitle: 'buried disulfide bond · 4.4 Å',
    i: 116,
    j: 181,
  },
  {
    label: 'β-strand packing (Ser32 ↔ His40)',
    subtitle: 'short-range contact · 6.3 Å',
    i: 17,
    j: 23,
  },
  {
    label: 'Asp189 ↔ Gly226',
    subtitle: 'long-range S1 pocket contact · 6.2 Å',
    i: 169,
    j: 201,
  },
  {
    label: 'Indirect coupling',
    subtitle: 'high coupling, not a contact · ~15 Å',
    i: 12,
    j: 186,
  },
  {
    label: 'Distant, no coupling',
    subtitle: 'opposite ends of the fold · >20 Å',
    i: 1,
    j: 100,
  },
];

// Color scale for coupling: 0 → transparent, 1 → accent red
function couplingColor(v: number): string {
  // Clamp to [0, 1]
  const c = Math.max(0, Math.min(1, v));
  // sqrt gamma to make mid-low values more visible
  const a = Math.pow(c, 0.6);
  return `rgba(220, 60, 60, ${a.toFixed(3)})`;
}
// Amino-acid "chemistry class" color for the MSA grid. Muted so the
// alignment reads as a pattern rather than a rainbow.
const AA_COLORS: Record<string, string> = {
  // Hydrophobic
  A: '#666', V: '#666', L: '#666', I: '#666', M: '#666', F: '#666', W: '#666', Y: '#666',
  // Polar
  S: '#6a8', T: '#6a8', N: '#6a8', Q: '#6a8', C: '#6a8',
  // Positive
  K: '#58d', R: '#58d', H: '#58d',
  // Negative
  D: '#d86', E: '#d86',
  // Special
  G: '#999', P: '#999',
};
function residueFill(aa: string): string {
  return AA_COLORS[aa.toUpperCase()] ?? '#555';
}

export default function CoevolutionViewer() {
  const [data, setData] = useState<CoevolData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ i: number; j: number } | null>({ i: 116, j: 181 });

  // Load the JSON on mount.
  useEffect(() => {
    let cancelled = false;
    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`${DATA_URL} ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setData(d as CoevolData);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <figure className="coevol-root">
        <div className="coevol-error">
          Failed to load co-evolution data: {error}
          <br />
          <small>
            Expected data at <code>{DATA_URL}</code>. Run{' '}
            <code>python scripts/build_coevolution_demo.py</code> to generate it.
          </small>
        </div>
      </figure>
    );
  }

  if (!data) {
    return (
      <figure className="coevol-root">
        <div className="coevol-loading">Loading co-evolution data…</div>
      </figure>
    );
  }

  return <CoevolWidget data={data} selected={selected} setSelected={setSelected} />;
}

// -----------------------------------------------------------------------------
// Main widget body (only rendered once data is loaded)
// -----------------------------------------------------------------------------

function CoevolWidget({
  data,
  selected,
  setSelected,
}: {
  data: CoevolData;
  selected: { i: number; j: number } | null;
  setSelected: (s: { i: number; j: number } | null) => void;
}) {
  const N = data.length;

  // The coupling/distance for the selected pair (for caption readout).
  const readout = useMemo(() => {
    if (!selected) return null;
    const { i, j } = selected;
    if (i < 1 || i > N || j < 1 || j > N) return null;
    const c = data.coupling[i - 1][j - 1];
    const d = data.distance[i - 1][j - 1];
    return { coupling: c, distance: d };
  }, [selected, data, N]);

  // (baseline / fold-improvement figures previously shown in the widget
  // sidebar have moved into the surrounding prose — the widget now
  // focuses on the three interactive visuals.)

  // Set preset
  const pickPreset = useCallback(
    (i: number, j: number) => setSelected({ i: Math.min(i, j), j: Math.max(i, j) }),
    [setSelected],
  );

  return (
    <figure className="coevol-root">
      <div className="coevol-header">
        <div className="coevol-title">
          <strong>{data.protein}</strong> co-evolution ↔ 3D contact
          <span className="coevol-sub">
            {' '}· {data.sequences.length} homologs · ref {data.reference.pdb_id}{' '}
            ({data.reference.name})
          </span>
        </div>
        <div className="coevol-readout">
          {readout ? (
            <>
              <span className="coevol-readout-label">resi</span>
              <span className="coevol-readout-value">
                {data.column_pdb_residues[selected!.i - 1]}–
                {data.column_pdb_residues[selected!.j - 1]}
              </span>
              <span className="coevol-readout-label">coupling</span>
              <span
                className="coevol-readout-value"
                style={{
                  color: couplingColor(readout.coupling).replace(/,\s*[\d.]+\)/, ',1)'),
                }}
              >
                {readout.coupling.toFixed(3)}
              </span>
              <span className="coevol-readout-label">distance</span>
              <span className="coevol-readout-value" style={{ color: '#6aa' }}>
                {readout.distance === null ? '—' : `${readout.distance.toFixed(1)} Å`}
              </span>
            </>
          ) : (
            <span className="coevol-readout-placeholder">
              click a cell on the heatmap, or try a preset below
            </span>
          )}
        </div>
      </div>

      {/* Presets: horizontal row above the viewers. The surrounding
         prose now carries the legend / precision figure / "how to read
         it" material that used to live in the sidebar, so the viewers
         get the full widget width. */}
      <div className="coevol-presets-row">
        <span className="coevol-presets-label">Try a preset:</span>
        <div className="coevol-presets-list">
          {PRESETS.map((p) => (
            <button
              key={`preset-${p.i}-${p.j}`}
              className={
                selected && selected.i === p.i && selected.j === p.j
                  ? 'coevol-preset coevol-preset--on'
                  : 'coevol-preset'
              }
              onClick={() => pickPreset(p.i, p.j)}
            >
              <span className="coevol-preset-label">{p.label}</span>
              <span className="coevol-preset-sub">{p.subtitle}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 3D viewer on top, full widget-width. */}
      <div className="coevol-panel coevol-panel--structure">
        <div className="coevol-panel-title">
          3D structure · {data.reference.pdb_id}
        </div>
        <StructurePanel data={data} selected={selected} />
      </div>

      {/* Heatmap + MSA side-by-side below, also full widget-width. */}
      <div className="coevol-bottom-row">
        <div className="coevol-panel coevol-panel--heatmap">
          <div className="coevol-panel-title">Contact-prediction heatmap</div>
          <HeatmapPanel data={data} selected={selected} onSelect={setSelected} />
        </div>
        <div className="coevol-panel coevol-panel--msa">
          <div className="coevol-panel-title">
            MSA · {data.sequences.length} sequences × {N} columns
          </div>
          <MSAPanel
            data={data}
            selected={selected}
            onPickCol={(col) => {
              if (!selected) setSelected({ i: col, j: Math.min(col + 10, N) });
              else if (selected.i === col || selected.j === col) setSelected(selected);
              else if (Math.abs(col - selected.i) <= Math.abs(col - selected.j))
                setSelected({ i: Math.min(col, selected.j), j: Math.max(col, selected.j) });
              else setSelected({ i: Math.min(selected.i, col), j: Math.max(selected.i, col) });
            }}
          />
        </div>
      </div>

      <style>{`
        .coevol-root {
          margin: 1.75rem 0;
          border: 1px solid var(--rule);
          border-radius: 6px;
          padding: 1rem 1.1rem 0.9rem;
          background: color-mix(in oklab, var(--bg) 94%, var(--rule) 6%);
          font-family: var(--font-sans);
        }
        .coevol-error, .coevol-loading {
          padding: 2rem;
          text-align: center;
          color: var(--fg-muted);
        }
        .coevol-error code { font-family: var(--font-mono); font-size: 0.85em; }

        /* Header: title + readout */
        .coevol-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          gap: 1rem;
          flex-wrap: wrap;
          margin-bottom: 0.75rem;
        }
        .coevol-title {
          font-size: 0.95rem;
          color: var(--fg);
        }
        .coevol-title strong { font-weight: 600; }
        .coevol-sub {
          color: var(--fg-muted);
          font-size: 0.82rem;
        }
        .coevol-readout {
          display: inline-flex;
          gap: 0.55rem 1rem;
          align-items: baseline;
          padding: 0.4rem 0.7rem;
          border: 1px solid var(--rule);
          border-radius: 4px;
          font-family: var(--font-mono);
          font-size: 0.85rem;
          background: color-mix(in oklab, var(--bg) 88%, var(--rule) 12%);
          flex-wrap: wrap;
        }
        .coevol-readout-label {
          color: var(--fg-muted);
          font-size: 0.68rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .coevol-readout-value {
          color: var(--fg);
          font-weight: 600;
          min-width: 2.5rem;
          display: inline-block;
          font-variant-numeric: tabular-nums;
        }
        .coevol-readout-placeholder {
          color: var(--fg-muted);
          font-style: italic;
          font-family: var(--font-sans);
        }

        /* Presets: horizontal row above the viewers, wraps on narrow
           widths. Each preset button stacks its label and subtitle
           vertically to keep per-button width moderate. */
        .coevol-presets-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.5rem 0.75rem;
          margin-bottom: 0.9rem;
        }
        .coevol-presets-label {
          font-size: 0.74rem;
          color: var(--fg-muted);
          margin-right: 0.1rem;
        }
        .coevol-presets-list {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem;
        }
        .coevol-preset {
          padding: 0.35rem 0.65rem;
          border: 1px solid var(--rule);
          border-radius: 4px;
          background: transparent;
          font: inherit;
          font-size: 0.78rem;
          color: var(--fg);
          cursor: pointer;
          display: inline-flex;
          flex-direction: column;
          line-height: 1.25;
          text-align: left;
        }
        .coevol-preset:hover { border-color: var(--fg-muted); }
        .coevol-preset--on {
          border-color: var(--accent);
          background: color-mix(in oklab, var(--accent) 14%, transparent);
        }
        .coevol-preset-label { font-weight: 500; }
        .coevol-preset-sub {
          font-size: 0.7rem;
          color: var(--fg-muted);
          margin-top: 1px;
        }

        /* Main viewing area: 3D viewer on top (full-width), then
           heatmap + MSA side-by-side below. No sidebar. */
        .coevol-panel--structure {
          margin-bottom: 0.85rem;
        }
        .coevol-bottom-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 0.85rem;
        }
        @media (max-width: 600px) {
          .coevol-bottom-row { grid-template-columns: 1fr; }
        }
        .coevol-panel {
          display: flex;
          flex-direction: column;
          min-width: 0;
          /* min-height: 0 lets flex children (like the scrolling MSA
             wrap) shrink below their intrinsic content size, so the
             bottom-row panels line up at both top and bottom. */
          min-height: 0;
        }
        .coevol-panel-title {
          font-size: 0.72rem;
          color: var(--fg-muted);
          letter-spacing: 0.05em;
          text-transform: uppercase;
          margin-bottom: 0.4rem;
          /* Titles one-line so the bottom-row panels start their visual
             content at the same y-coordinate. */
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `}</style>
    </figure>
  );
}

// -----------------------------------------------------------------------------
// Panel A — MSA canvas
// -----------------------------------------------------------------------------

function MSAPanel({
  data,
  selected,
  onPickCol,
}: {
  data: CoevolData;
  selected: { i: number; j: number } | null;
  onPickCol: (col: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Dimensions
  const cellW = 4; // px per column
  const cellH = 4; // px per sequence row
  const N = data.length;
  const nSeq = data.sequences.length;
  const W = N * cellW;
  const H = nSeq * cellH;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // DPR-aware sizing
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    // Draw cells
    for (let r = 0; r < nSeq; r++) {
      const seq = data.sequences[r].aligned;
      for (let c = 0; c < N; c++) {
        const aa = seq[c];
        const isSelectedCol =
          selected && (c + 1 === selected.i || c + 1 === selected.j);
        if (aa === '-') {
          ctx.fillStyle = isSelectedCol ? 'rgba(220,60,60,0.15)' : 'rgba(128,128,128,0.12)';
        } else {
          ctx.fillStyle = residueFill(aa);
        }
        ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
      }
    }

    // Overlay selected columns with a transparent accent band
    if (selected) {
      ctx.fillStyle = 'rgba(220,60,60,0.18)';
      ctx.fillRect((selected.i - 1) * cellW, 0, cellW, H);
      ctx.fillRect((selected.j - 1) * cellW, 0, cellW, H);
      // Border around each selected column
      ctx.strokeStyle = 'rgba(220,60,60,0.95)';
      ctx.lineWidth = 1;
      ctx.strokeRect((selected.i - 1) * cellW + 0.5, 0.5, cellW - 1, H - 1);
      ctx.strokeRect((selected.j - 1) * cellW + 0.5, 0.5, cellW - 1, H - 1);
    }
  }, [data, selected, N, nSeq, W, H]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const col = Math.floor(x / cellW) + 1;
    if (col >= 1 && col <= N) onPickCol(col);
  };

  return (
    <div className="msa-panel-wrap" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        role="img"
        aria-label={`Multiple sequence alignment, ${nSeq} sequences by ${N} columns. Click to select a column.`}
        style={{ cursor: 'pointer', display: 'block' }}
      />
      <style>{`
        .msa-panel-wrap {
          border: 1px solid var(--rule);
          border-radius: 4px;
          overflow: auto;
          background: color-mix(in oklab, var(--bg) 90%, var(--rule) 10%);
          /* Match the heatmap's square aspect so both bottom-row panels
             contribute equal intrinsic heights to the grid. Without
             this, the MSA's 2000-row × 220-col canvas (≈ 8000 × 880 px)
             forces the grid row to grow to 8000 px tall, which drags
             the heatmap along with it. The 8000 px canvas now scrolls
             inside a ~panel-width × panel-width box. */
          aspect-ratio: 1 / 1;
        }
      `}</style>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Panel B — Heatmap canvas
// -----------------------------------------------------------------------------

function HeatmapPanel({
  data,
  selected,
  onSelect,
}: {
  data: CoevolData;
  selected: { i: number; j: number } | null;
  onSelect: (s: { i: number; j: number } | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const N = data.length;
  // Internal rendering resolution. We draw at this size for crisp cells,
  // then CSS scales the canvas down to fit the container width. The
  // displayed size is determined entirely by the panel layout (container
  // width × aspect-ratio 1/1).
  const cell = 4;
  const W = N * cell;
  const H = N * cell;
  const minSep = data.min_separation;
  const threshold = data.contact_threshold_A;

  // Precompute: set of (i, j) pairs that are true 8-Å contacts, for
  // hit/miss colouring of the top-coupling predictions. 1-indexed.
  const trueContactSet = useMemo(() => {
    const cc = new Set<number>();
    for (let i = 0; i < N; i++) {
      for (let j = i + minSep; j < N; j++) {
        const d = data.distance[i][j];
        if (d !== null && d <= threshold) {
          cc.add((i + 1) * 1000 + (j + 1));
        }
      }
    }
    return cc;
  }, [data, N, minSep, threshold]);

  // Drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // Internal resolution × DPR. Display width is set by CSS so the
    // canvas scales to the container, but we render at full resolution
    // for crispness on high-DPR screens.
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Subtle background fill
    ctx.fillStyle = 'rgba(128,128,128,0.03)';
    ctx.fillRect(0, 0, W, H);

    // Diagonal band (|i - j| < minSep): light gray so the reader sees the
    // excluded zone
    ctx.fillStyle = 'rgba(128,128,128,0.14)';
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (Math.abs(i - j) < minSep) {
          ctx.fillRect(j * cell, i * cell, cell, cell);
        }
      }
    }

    // Upper-right triangle: top-coupling predictions
    // - "hit" (also a true contact) — bright red
    // - "miss" (not a contact) — pale red
    for (const [i, j] of data.top_coupling_pairs) {
      const isHit = trueContactSet.has(i * 1000 + j);
      ctx.fillStyle = isHit ? 'rgba(220, 60, 60, 0.95)' : 'rgba(220, 60, 60, 0.28)';
      // upper-right = column > row, so (row = i-1, col = j-1)
      ctx.fillRect((j - 1) * cell, (i - 1) * cell, cell, cell);
    }

    // Lower-left triangle: top-contact pairs, shaded by distance
    for (const [i, j, d] of data.top_contact_pairs) {
      // Darker blue for closer contacts (within 6-8 Å). Intensity from 0.5 .. 1.0
      const norm = Math.max(0, Math.min(1, (12 - d) / 6));
      const alpha = 0.45 + 0.45 * norm;
      ctx.fillStyle = `rgba(70, 130, 200, ${alpha.toFixed(3)})`;
      // lower-left = row > col, so (row = j-1, col = i-1)
      ctx.fillRect((i - 1) * cell, (j - 1) * cell, cell, cell);
    }

    // Selection crosshair
    if (selected) {
      const i = selected.i - 1;
      const j = selected.j - 1;
      ctx.strokeStyle = 'rgba(232, 161, 161, 0.85)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(0, (i + 0.5) * cell);
      ctx.lineTo(W, (i + 0.5) * cell);
      ctx.moveTo(0, (j + 0.5) * cell);
      ctx.lineTo(W, (j + 0.5) * cell);
      ctx.moveTo((i + 0.5) * cell, 0);
      ctx.lineTo((i + 0.5) * cell, H);
      ctx.moveTo((j + 0.5) * cell, 0);
      ctx.lineTo((j + 0.5) * cell, H);
      ctx.stroke();
      ctx.fillStyle = 'rgba(232, 161, 161, 1)';
      const r = Math.max(cell * 1.3, 4);
      const xU = j * cell + cell / 2;
      const yU = i * cell + cell / 2;
      const xL = i * cell + cell / 2;
      const yL = j * cell + cell / 2;
      ctx.beginPath();
      ctx.arc(xU, yU, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(xL, yL, r, 0, 2 * Math.PI);
      ctx.fill();
    }
  }, [data, selected, N, cell, W, H, minSep, trueContactSet]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    // Canvas is CSS-scaled; convert screen coords back to internal coords.
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const col = Math.floor(x / cell);
    const row = Math.floor(y / cell);
    if (col < 0 || col >= N || row < 0 || row >= N) return;
    const i = Math.min(col, row) + 1;
    const j = Math.max(col, row) + 1;
    if (i === j) return;
    onSelect({ i, j });
  };

  return (
    <div className="heatmap-panel-wrap">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        role="img"
        aria-label={`Contact-prediction heatmap: upper-right shows the top-${data.top_n} coupling predictions (bright = landed on a true contact, faint = false positive); lower-left shows real 3D contacts. Click a cell to select a residue pair.`}
        style={{
          cursor: 'crosshair',
          display: 'block',
          width: '100%',
          height: 'auto',
          aspectRatio: '1 / 1',
        }}
      />
      <style>{`
        .heatmap-panel-wrap {
          border: 1px solid var(--rule);
          border-radius: 4px;
          background: color-mix(in oklab, var(--bg) 92%, var(--rule) 8%);
          /* No overflow / max-height here — the canvas scales to fit the
             panel width, so there's nothing to scroll. */
        }
      `}</style>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Panel C — 3Dmol structure viewer
// -----------------------------------------------------------------------------

function StructurePanel({
  data,
  selected,
}: {
  data: CoevolData;
  selected: { i: number; j: number } | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [vError, setVError] = useState<string | null>(null);

  // Initialize 3Dmol viewer once the container is mounted.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!containerRef.current) return;
      try {
        const $3Dmol = await load3Dmol();
        if (cancelled) return;
        const viewer = $3Dmol.createViewer(containerRef.current, {
          backgroundColor: 'rgb(24,24,28)',
          antialias: true,
        });
        viewer.addModel(data.pdb, 'pdb');
        viewer.setStyle({}, { cartoon: { color: 'spectrum', opacity: 0.85 } });
        viewer.zoomTo();
        viewer.render();
        viewerRef.current = viewer;
        setReady(true);
      } catch (e) {
        if (!cancelled) setVError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      try {
        viewerRef.current?.clear?.();
      } catch {
        /* ignore */
      }
      viewerRef.current = null;
    };
  }, [data.pdb]);

  // Update the selection highlights whenever `selected` changes.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;

    // Reset all residue-specific styles; re-apply base cartoon.
    viewer.setStyle({}, { cartoon: { color: 'spectrum', opacity: 0.85 } });
    viewer.removeAllLabels();
    viewer.removeAllShapes();

    if (selected) {
      const { i, j } = selected;
      // Translate from alignment column → PDB residue number. Trypsin's
      // crystal structure uses chymotrypsin numbering which starts at 16
      // and skips missing residues, so col 116 ≠ PDB resi 116.
      const resiI = data.column_pdb_residues[i - 1];
      const resiJ = data.column_pdb_residues[j - 1];

      viewer.setStyle({ resi: `${resiI}` }, {
        cartoon: { color: '#e8a1a1', thickness: 1.2 },
      });
      viewer.setStyle({ resi: `${resiJ}` }, {
        cartoon: { color: '#a1c8e8', thickness: 1.2 },
      });
      viewer.addStyle({ resi: `${resiI}`, atom: 'CA' }, {
        sphere: { color: '#e8a1a1', radius: 1.2 },
      });
      viewer.addStyle({ resi: `${resiJ}`, atom: 'CA' }, {
        sphere: { color: '#a1c8e8', radius: 1.2 },
      });

      // Dashed line between the two Cα atoms
      viewer.addLine({
        start: { resi: `${resiI}`, atom: 'CA' },
        end: { resi: `${resiJ}`, atom: 'CA' },
        dashed: true,
        color: 'white',
        linewidth: 3,
      });

      const d = data.distance[i - 1][j - 1];
      const label = d === null ? `${resiI}–${resiJ}` : `${d.toFixed(1)} Å`;
      // Position label near whichever residue is more central
      const midResi = data.column_pdb_residues[Math.round((i + j) / 2) - 1];
      viewer.addLabel(label, {
        position: { resi: `${midResi}`, atom: 'CA' },
        backgroundColor: 'rgba(30,30,36,0.85)',
        backgroundOpacity: 0.85,
        fontColor: 'white',
        fontSize: 12,
        borderThickness: 1,
        borderColor: 'rgba(255,255,255,0.2)',
      });
    }

    viewer.render();
  }, [selected, ready, data.distance, data.column_pdb_residues]);

  return (
    <div className="structure-panel-wrap">
      <div
        ref={containerRef}
        className="structure-panel-container"
        style={{ position: 'relative' }}
      />
      {vError && <div className="structure-error">3D viewer error: {vError}</div>}
      <style>{`
        .structure-panel-wrap {
          border: 1px solid var(--rule);
          border-radius: 4px;
          overflow: hidden;
          background: rgb(24,24,28);
        }
        .structure-panel-container {
          width: 100%;
          /* Widescreen aspect for the 3D viewer now that it spans the
             full main-area width. Gives the reader room to see the fold
             without dominating the vertical viewport. */
          aspect-ratio: 2.4 / 1;
          min-height: 260px;
        }
        .structure-error {
          padding: 1rem;
          color: #e8a1a1;
          font-size: 0.8rem;
        }
      `}</style>
    </div>
  );
}
