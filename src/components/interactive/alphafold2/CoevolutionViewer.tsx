import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Three linked explorers: reference structure, coupling/contact map, and full MSA.
 * Coupling is a relative sequence-derived score, and contact is evaluated
 * separately against the reference structure's Cα distances.
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

type Point3 = { x: number; y: number; z: number };
type Quaternion = { x: number; y: number; z: number; w: number };
type CoevolViewerWithAnimation = {
  __coevolRotationAnimation?: number;
  rotationGroup?: { quaternion?: any };
  show?: () => void;
  render?: () => void;
};

function pointFromAtom(atom: any): Point3 | null {
  if (!atom) return null;
  const { x, y, z } = atom;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function add3(a: Point3, b: Point3): Point3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub3(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function mul3(a: Point3, s: number): Point3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function dot3(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross3(a: Point3, b: Point3): Point3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function norm3(a: Point3): number {
  return Math.hypot(a.x, a.y, a.z);
}

function normalize3(a: Point3): Point3 | null {
  const n = norm3(a);
  if (n < 1e-6) return null;
  return mul3(a, 1 / n);
}

function averagePoint(points: Point3[]): Point3 | null {
  if (!points.length) return null;
  const sum = points.reduce((acc, point) => add3(acc, point), { x: 0, y: 0, z: 0 });
  return mul3(sum, 1 / points.length);
}

function fallbackPerpendicular(axis: Point3): Point3 {
  const ref = Math.abs(axis.x) < 0.8 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return normalize3(cross3(axis, ref)) ?? { x: 0, y: 0, z: 1 };
}

function normalizeQuaternion(q: Quaternion): Quaternion {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (n < 1e-6) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

function quaternionDot(a: Quaternion, b: Quaternion): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

function slerpQuaternion(from: Quaternion, rawTo: Quaternion, t: number): Quaternion {
  let to = rawTo;
  let dot = quaternionDot(from, to);
  if (dot < 0) {
    to = { x: -to.x, y: -to.y, z: -to.z, w: -to.w };
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQuaternion({
      x: from.x + t * (to.x - from.x),
      y: from.y + t * (to.y - from.y),
      z: from.z + t * (to.z - from.z),
      w: from.w + t * (to.w - from.w),
    });
  }

  const theta0 = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta0 = Math.sin(theta0);
  const theta = theta0 * t;
  const scaleFrom = Math.sin(theta0 - theta) / sinTheta0;
  const scaleTo = Math.sin(theta) / sinTheta0;
  return normalizeQuaternion({
    x: from.x * scaleFrom + to.x * scaleTo,
    y: from.y * scaleFrom + to.y * scaleTo,
    z: from.z * scaleFrom + to.z * scaleTo,
    w: from.w * scaleFrom + to.w * scaleTo,
  });
}

function quaternionFromRotationRows(xAxis: Point3, yAxis: Point3, zAxis: Point3): Quaternion {
  const m00 = xAxis.x;
  const m01 = xAxis.y;
  const m02 = xAxis.z;
  const m10 = yAxis.x;
  const m11 = yAxis.y;
  const m12 = yAxis.z;
  const m20 = zAxis.x;
  const m21 = zAxis.y;
  const m22 = zAxis.z;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return normalizeQuaternion({
      w: 0.25 * s,
      x: (m21 - m12) / s,
      y: (m02 - m20) / s,
      z: (m10 - m01) / s,
    });
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return normalizeQuaternion({
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    });
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return normalizeQuaternion({
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    });
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return normalizeQuaternion({
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
  });
}

function smoothRotateViewerToQuaternion(viewer: CoevolViewerWithAnimation, target: Quaternion) {
  const current = viewer.rotationGroup?.quaternion;
  if (!current || typeof window === 'undefined') return false;

  if (viewer.__coevolRotationAnimation) {
    window.cancelAnimationFrame(viewer.__coevolRotationAnimation);
  }

  const start = normalizeQuaternion({
    x: current.x ?? 0,
    y: current.y ?? 0,
    z: current.z ?? 0,
    w: current.w ?? 1,
  });
  const end = normalizeQuaternion(target);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Object.assign(current, end);
    current.normalize?.();
    viewer.show?.();
    viewer.render?.();
    viewer.__coevolRotationAnimation = undefined;
    return true;
  }
  const durationMs = 850;
  const startTime = window.performance.now();

  const step = (now: number) => {
    const rawT = Math.min(1, (now - startTime) / durationMs);
    const easedT = 1 - Math.pow(1 - rawT, 3);
    const q = slerpQuaternion(start, end, easedT);
    current.x = q.x;
    current.y = q.y;
    current.z = q.z;
    current.w = q.w;
    current.normalize?.();
    viewer.show?.();

    if (rawT < 1) {
      viewer.__coevolRotationAnimation = window.requestAnimationFrame(step);
    } else {
      viewer.__coevolRotationAnimation = undefined;
      viewer.render?.();
    }
  };

  viewer.__coevolRotationAnimation = window.requestAnimationFrame(step);
  return true;
}

function orientViewerToPair(viewer: any, pointI: Point3, pointJ: Point3) {
  const pairAxis = normalize3(sub3(pointJ, pointI));
  if (!pairAxis) return;

  const midpoint = mul3(add3(pointI, pointJ), 0.5);
  const caPoints = (viewer.selectedAtoms({ atom: 'CA' }) ?? [])
    .map(pointFromAtom)
    .filter((point: Point3 | null): point is Point3 => point !== null);
  const proteinCenter = averagePoint(caPoints) ?? midpoint;
  const outward = sub3(midpoint, proteinCenter);
  const perpendicularOutward = sub3(outward, mul3(pairAxis, dot3(outward, pairAxis)));
  const zAxis = normalize3(perpendicularOutward) ?? fallbackPerpendicular(pairAxis);
  const yAxis = normalize3(cross3(zAxis, pairAxis)) ?? fallbackPerpendicular(zAxis);
  const correctedZAxis = normalize3(cross3(pairAxis, yAxis)) ?? zAxis;
  const q = quaternionFromRotationRows(pairAxis, yAxis, correctedZAxis);
  if (smoothRotateViewerToQuaternion(viewer, q)) return;

  const view = viewer.getView();
  viewer.setView([view[0], view[1], view[2], view[3], q.x, q.y, q.z, q.w], true);
}

// Fixed examples verified against the bundled data. Indices are alignment columns.
const PRESETS = [
  { label: 'Coupled and close', subtitle: 'A high score agrees with a 3D contact', i: 116, j: 181 },
  { label: 'Coupled but distant', subtitle: 'A high score does not guarantee contact', i: 12, j: 186 },
  { label: 'Distant with a low score', subtitle: 'Compare a weakly scored, distant pair', i: 1, j: 100 },
];

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

function CoevolWidget({ data, selected, setSelected }: {
  data: CoevolData;
  selected: { i: number; j: number } | null;
  setSelected: (selection: { i: number; j: number } | null) => void;
}) {
  const N = data.length;
  const [draftI, setDraftI] = useState(String(selected?.i ?? 116));
  const [draftJ, setDraftJ] = useState(String(selected?.j ?? 181));
  const [selectionError, setSelectionError] = useState('');
  useEffect(() => {
    if (selected) { setDraftI(String(selected.i)); setDraftJ(String(selected.j)); setSelectionError(''); }
  }, [selected]);
  const readout = useMemo(() => {
    if (!selected || selected.i < 1 || selected.i > N || selected.j < 1 || selected.j > N) return null;
    return { coupling: data.coupling[selected.i - 1][selected.j - 1], distance: data.distance[selected.i - 1][selected.j - 1] };
  }, [selected, data, N]);
  const pickPair = useCallback((i: number, j: number) => setSelected({ i: Math.min(i, j), j: Math.max(i, j) }), [setSelected]);
  const isContact = readout?.distance !== null && readout?.distance !== undefined && readout.distance <= data.contact_threshold_A;

  return <figure className="coevol-root">
    <div className="coevol-header"><strong>{data.protein}: coevolution ↔ 3D contact</strong><span>{data.sequences.length.toLocaleString()} sequences · PDB {data.reference.pdb_id}</span></div>
    <div className="coevol-toolbar">
      <div className="coevol-presets-list" role="group" aria-label="Example residue pairs">{PRESETS.map(preset => <button type="button" key={preset.label} className="coevol-preset" title={preset.subtitle} aria-pressed={selected?.i === preset.i && selected?.j === preset.j} onClick={() => pickPair(preset.i, preset.j)}>{preset.label}</button>)}</div>
      <form className="coevol-pair-form" aria-label="Choose alignment columns" onSubmit={event => {
        event.preventDefault();
        const i = Number(draftI), j = Number(draftJ);
        if (!Number.isInteger(i) || !Number.isInteger(j) || i < 1 || i > N || j < 1 || j > N) { setSelectionError(`Choose whole-number columns between 1 and ${N}.`); return; }
        if (i === j) { setSelectionError('Choose two different alignment columns.'); return; }
        setSelectionError(''); pickPair(i, j);
      }}><label>i<input type="number" aria-label="Alignment column i" min={1} max={N} step={1} required value={draftI} onChange={event => setDraftI(event.currentTarget.value)} /></label><label>j<input type="number" aria-label="Alignment column j" min={1} max={N} step={1} required value={draftJ} onChange={event => setDraftJ(event.currentTarget.value)} /></label><button type="submit">Inspect →</button></form>
    </div>
    {selectionError && <p className="coevol-selection-error" role="alert">{selectionError}</p>}
    {selected && readout && <div className="coevol-readout" aria-live="polite">
      <span><small>Alignment columns</small><strong>{selected.i}–{selected.j}</strong></span>
      <span><small>PDB residues</small><strong>{data.column_pdb_residues[selected.i - 1]}–{data.column_pdb_residues[selected.j - 1]}</strong></span>
      <span><small>Relative coupling</small><strong>{readout.coupling.toFixed(3)}</strong></span>
      <span><small>Cα distance</small><strong>{readout.distance === null ? 'Unavailable' : `${readout.distance.toFixed(1)} Å`}</strong></span>
      <span><small>Contact ≤ {data.contact_threshold_A} Å</small><strong>{readout.distance === null ? 'Unknown' : isContact ? 'Yes' : 'No'}</strong></span>
    </div>}

    <div className="coevol-panel coevol-panel--structure"><div className="coevol-panel-title"><strong>Reference structure · {data.reference.pdb_id}</strong><span>Drag to rotate · scroll to zoom</span></div><StructurePanel data={data} selected={selected} /></div>
    <div className="coevol-bottom-row">
      <div className="coevol-panel coevol-panel--heatmap"><div className="coevol-panel-title"><strong>Coupling and contact map</strong><span>Hover to inspect · click to select</span></div><HeatmapPanel data={data} selected={selected} onSelect={setSelected} /><p className="coevol-small"><b className="coevol-coupling-key">Upper triangle:</b> top-L coupling predictions; dark marks meet the contact threshold, pale marks do not. <b className="coevol-contact-key">Lower triangle:</b> measured reference contacts.</p></div>
      <div className="coevol-panel coevol-panel--msa"><div className="coevol-panel-title"><strong>Full alignment</strong><span>{data.sequences.length.toLocaleString()} sequences × {N} columns</span></div><MSAPanel data={data} selected={selected} onPickCol={col => {
        if (!selected) pickPair(col, col === N ? col - 10 : Math.min(col + 10, N));
        else if (selected.i === col || selected.j === col) return;
        else if (Math.abs(col - selected.i) <= Math.abs(col - selected.j)) pickPair(col, selected.j);
        else pickPair(selected.i, col);
      }} /><p className="coevol-small">Scroll through the full alignment. Click a column to move the nearer selection; the same pair updates the map, structure, and readout.</p></div>
    </div>
    <figcaption className="coevol-caption"><strong>Coupling is a relative score, not a contact probability.</strong> The line joins the selected Cα atoms in the reference structure. In this dataset, {(data.top_coupling_precision * 100).toFixed(1)}% of the top {data.top_n} scored pairs meet the ≤ {data.contact_threshold_A} Å threshold (sequence separation ≥ {data.min_separation}). Alignment columns and PDB residue numbers are different numbering systems.
      {selected && Math.abs(selected.i - selected.j) < data.min_separation && <span className="coevol-excluded"> This selected pair is too close along the sequence to be included in that top-L evaluation.</span>}
    </figcaption>
    <style>{`
      .coevol-root{margin:1.75rem 0;padding:1rem;border:1px solid var(--rule);border-radius:.6rem;background:var(--surface-strong);font-family:var(--font-sans);color:var(--fg)}.coevol-header{display:flex;align-items:baseline;flex-wrap:wrap;gap:.35rem .8rem;margin:0 0 .65rem}.coevol-header>strong{font-size:.95rem}.coevol-header>span{font-size:.7rem;color:var(--fg-muted)}
      .coevol-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.55rem;padding-bottom:.7rem}.coevol-presets-list{display:flex;flex-wrap:wrap;gap:.35rem}.coevol-root button{min-height:2.25rem;padding:.4rem .55rem;border:1px solid var(--rule);border-radius:.3rem;background:var(--bg);color:var(--fg);font:500 .69rem var(--font-sans);cursor:pointer}.coevol-preset[aria-pressed=true]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}.coevol-root button:hover{border-color:var(--accent)}.coevol-root :is(button,input):focus-visible{outline:2px solid var(--focus);outline-offset:3px}
      .coevol-pair-form{display:flex;align-items:center;gap:.4rem}.coevol-pair-form label{display:flex;align-items:center;gap:.3rem;color:var(--fg-muted);font:.72rem var(--font-mono)}.coevol-pair-form input{width:3.6rem;min-height:2.25rem;padding:.35rem;border:1px solid var(--rule);border-radius:.25rem;background:var(--surface-strong);color:var(--fg);font:.75rem var(--font-mono)}.coevol-pair-form button{background:var(--accent);color:var(--bg);border-color:var(--accent)}.coevol-selection-error{margin:0 0 .7rem;color:var(--data-pair);font-size:.75rem}
      .coevol-readout{display:flex;flex-wrap:wrap;gap:.55rem 1.1rem;align-items:baseline;padding:.65rem .8rem;margin-bottom:.9rem;border-block:1px solid var(--rule);background:var(--bg)}.coevol-readout>span{display:inline-flex;align-items:baseline;gap:.4rem;white-space:nowrap}.coevol-readout small{color:var(--fg-muted);font-size:.65rem}.coevol-readout strong{color:var(--fg);font:600 .82rem var(--font-mono)}
      .coevol-panel{display:flex;flex-direction:column;min-width:0;min-height:0}.coevol-panel-title{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:.25rem .6rem;margin-bottom:.5rem;font-size:.69rem;color:var(--fg-muted)}.coevol-panel-title strong{color:var(--fg);font-weight:600}.coevol-panel-title>span{font-size:.65rem}.coevol-bottom-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem;margin-top:1rem}.coevol-root .coevol-small{margin:.6rem 0 0;color:var(--fg-muted);font-size:.69rem;line-height:1.6}.coevol-coupling-key{color:#b95040}.coevol-contact-key{color:var(--data-msa)}.coevol-caption{margin:.85rem 0 0!important;padding-top:.8rem;border-top:1px solid var(--rule);color:var(--fg-muted);font-size:.72rem;line-height:1.7}.coevol-caption strong{color:var(--fg)}.coevol-excluded{color:var(--data-pair)}.coevol-error,.coevol-loading{padding:2rem;text-align:center;color:var(--fg-muted)}
      @media(max-width:600px){.coevol-root{padding:.8rem}.coevol-bottom-row{grid-template-columns:1fr}.coevol-readout{gap:.45rem .85rem;padding:.65rem}.coevol-readout>span{flex:1 1 7rem;justify-content:space-between}.coevol-readout>span:last-child{flex-grow:0}.coevol-toolbar{gap:.65rem}.coevol-presets-list{gap:.3rem}.coevol-root .coevol-preset{font-size:.66rem;padding:.4rem .5rem}.coevol-pair-form{width:100%}.coevol-pair-form label{flex:1}.coevol-pair-form input{width:100%;max-width:5rem}.coevol-header>strong{font-size:.9rem}}
    `}</style>
  </figure>;
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

  // Keep the selected columns in view when presets or the map change the pair.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !selected) return;
    const span = (selected.j - selected.i + 1) * cellW;
    const center = span <= container.clientWidth
      ? ((selected.i + selected.j) / 2 - 0.5) * cellW
      : (selected.i - 0.5) * cellW;
    container.scrollTo({ left: Math.max(0, center - container.clientWidth / 2), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [selected]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const col = Math.floor(x / cellW) + 1;
    if (col >= 1 && col <= N) onPickCol(col);
  };

  return (
    <div className="msa-panel-wrap" ref={containerRef} role="region" aria-label="Scrollable full multiple sequence alignment" tabIndex={0}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        role="img"
        aria-label={`Multiple sequence alignment, ${nSeq} sequences by ${N} columns. Click to select a column.`}
        style={{ cursor: 'pointer', display: 'block' }}
      />
      <style>{`
        .msa-panel-wrap canvas { max-width: none; }
        .msa-panel-wrap:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
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
  const [hoverPair, setHoverPair] = useState<{ i: number; j: number } | null>(null);
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

  const pairAtPointer = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    // Canvas is CSS-scaled; convert screen coords back to internal coords.
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const col = Math.floor(x / cell);
    const row = Math.floor(y / cell);
    if (col < 0 || col >= N || row < 0 || row >= N) return null;
    const i = Math.min(col, row) + 1;
    const j = Math.max(col, row) + 1;
    if (i === j) return null;
    return { i, j };
  };

  return (
    <div className="heatmap-panel-wrap">
      <canvas
        ref={canvasRef}
        onClick={event => { const pair = pairAtPointer(event); if (pair) onSelect(pair); }}
        onMouseMove={event => {
          const pair = pairAtPointer(event);
          setHoverPair(previous => previous?.i === pair?.i && previous?.j === pair?.j ? previous : pair);
        }}
        onMouseLeave={() => setHoverPair(null)}
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
      {hoverPair && <div className="heatmap-hover" aria-hidden="true">Columns {hoverPair.i}–{hoverPair.j} · score {data.coupling[hoverPair.i - 1][hoverPair.j - 1].toFixed(3)} · {data.distance[hoverPair.i - 1][hoverPair.j - 1]?.toFixed(1) ?? '—'} Å</div>}
      <style>{`
        .heatmap-panel-wrap {
          position: relative;
          border: 1px solid var(--rule);
          border-radius: 4px;
          background: color-mix(in oklab, var(--bg) 92%, var(--rule) 8%);
          /* No overflow / max-height here — the canvas scales to fit the
             panel width, so there's nothing to scroll. */
        }
        .heatmap-hover { position: absolute; bottom: .5rem; left: .5rem; right: .5rem; width: fit-content; max-width: calc(100% - 1rem); padding: .35rem .5rem; border: 1px solid var(--rule-strong); border-radius: .3rem; background: var(--surface-strong); color: var(--fg); box-shadow: var(--shadow-float); font: .65rem/1.5 var(--font-mono); pointer-events: none; }
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
  const distanceBadge = useMemo(() => {
    if (!selected) return null;
    const distance = data.distance[selected.i - 1]?.[selected.j - 1];
    if (distance === null || typeof distance === 'undefined') return null;
    return `${distance.toFixed(1)} Å`;
  }, [selected, data.distance]);

  // Initialize 3Dmol viewer once the container is mounted.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!containerRef.current) return;
      try {
        const $3Dmol = await load3Dmol();
        if (cancelled) return;
        const viewer = $3Dmol.createViewer(containerRef.current, {
          backgroundColor: '#10241f',
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
      if (viewerRef.current?.__coevolRotationAnimation) window.cancelAnimationFrame(viewerRef.current.__coevolRotationAnimation);
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
      const pointI = pointFromAtom(viewer.selectedAtoms({ resi: resiI, atom: 'CA' })?.[0]);
      const pointJ = pointFromAtom(viewer.selectedAtoms({ resi: resiJ, atom: 'CA' })?.[0]);

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

      // Visible distance edge between the two Cα atoms.
      if (pointI && pointJ) {
        viewer.addCylinder({
          start: pointI,
          end: pointJ,
          radius: 0.18,
          fromCap: 'round',
          toCap: 'round',
          color: '#f8fafc',
        });
      } else {
        viewer.addLine({
          start: { resi: `${resiI}`, atom: 'CA' },
          end: { resi: `${resiJ}`, atom: 'CA' },
          dashed: true,
          color: 'white',
          linewidth: 3,
        });
      }

      if (pointI && pointJ) {
        orientViewerToPair(viewer, pointI, pointJ);
      }
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
      {distanceBadge && (
        <div className="structure-distance-badge" aria-hidden="true">
          {distanceBadge}
        </div>
      )}
      {vError && <div className="structure-error">3D viewer error: {vError}</div>}
      <style>{`
        .structure-panel-wrap {
          border: 1px solid var(--rule);
          border-radius: 4px;
          overflow: hidden;
          background: #10241f;
          position: relative;
        }
        .structure-panel-container {
          width: 100%;
          /* Widescreen aspect for the 3D viewer now that it spans the
             full main-area width. Gives the reader room to see the fold
             without dominating the vertical viewport. */
          aspect-ratio: 2.4 / 1;
          min-height: 260px;
        }
        .structure-distance-badge {
          position: absolute;
          top: 0.65rem;
          right: 0.65rem;
          padding: 0.25rem 0.45rem;
          border: 1px solid #4a4a52;
          border-radius: 4px;
          background: rgba(30, 30, 36, 0.86);
          color: #f8fafc;
          font-family: var(--font-mono);
          font-size: 0.72rem;
          font-weight: 600;
          line-height: 1;
          pointer-events: none;
          z-index: 2;
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
