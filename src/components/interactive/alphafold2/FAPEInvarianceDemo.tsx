import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useMemo, useState } from 'react';
import * as THREE from 'three';

/** A Cα-only, synthetic-chain comparison of coordinate MSE and FAPE.
 * Predicted local frames are built from chain geometry. A local perturbation
 * is applied before a global rotation, preserving FAPE under that rotation.
 * FAPE averages clamped Euclidean distances (not squared distances), without
 * the length-scale normalization used by AlphaFold2. */

// Chain geometry: a slight S-curve so the structure has meaningful
// orientation (a straight chain would be boring and also degenerate for
// frame construction).
const N = 16;
const D_CLAMP = 3.0; // loss-clamp distance (in the arbitrary length units of
//                     the synthetic chain).

function buildTrueChain(): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = -2.5 + 5.0 * t;
    // S-curve in y, gentle wiggle in z
    const y = 0.8 * Math.sin(t * Math.PI * 1.6);
    const z = 0.35 * Math.cos(t * Math.PI * 2.4);
    pts.push(new THREE.Vector3(x, y, z));
  }
  return pts;
}

// Build a local frame at residue i using only coordinates from the chain.
// The real AF2 frame uses N, Cα, and C, which are non-collinear by chemistry.
// This demo only has one point per residue, so the endpoint "prev/current/next"
// construction would be degenerate. Instead, choose a tangent for x and then
// search nearby residues for a non-collinear plane vector. This is still built
// entirely from structure coordinates, so it rotates/translates equivariantly.
function frameAt(chain: THREE.Vector3[], i: number): { R: THREE.Matrix3; t: THREE.Vector3 } {
  const here = chain[i];
  const xVector = i === chain.length - 1
    ? here.clone().sub(chain[i - 1])
    : chain[i + 1].clone().sub(here);
  const xAxis = xVector.normalize();

  const candidateIndices = [
    i - 1,
    i + 1,
    i - 2,
    i + 2,
    0,
    chain.length - 1,
    Math.floor(chain.length / 2),
  ];

  let yAxis: THREE.Vector3 | null = null;
  for (const candidateIndex of candidateIndices) {
    if (candidateIndex < 0 || candidateIndex >= chain.length || candidateIndex === i) continue;
    const yRaw = chain[candidateIndex].clone().sub(here);
    const yProjected = yRaw.sub(xAxis.clone().multiplyScalar(yRaw.dot(xAxis)));
    if (yProjected.lengthSq() > 1e-10) {
      yAxis = yProjected.normalize();
      break;
    }
  }

  if (!yAxis) {
    throw new Error('Could not construct a non-degenerate local frame for FAPE demo');
  }

  const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
  yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();

  const R = new THREE.Matrix3();
  // Columns are (xAxis, yAxis, zAxis).
  R.set(
    xAxis.x, yAxis.x, zAxis.x,
    xAxis.y, yAxis.y, zAxis.y,
    xAxis.z, yAxis.z, zAxis.z,
  );
  return { R, t: here.clone() };
}

// Return x in the local frame of (R, t): R^T (x - t)
function toLocal(x: THREE.Vector3, frame: { R: THREE.Matrix3; t: THREE.Vector3 }): THREE.Vector3 {
  const v = x.clone().sub(frame.t);
  // Apply R^T: build transpose and apply
  const Rt = frame.R.clone().transpose();
  return v.applyMatrix3(Rt);
}

// -----------------------------------------------------------------------------
// Loss computations
// -----------------------------------------------------------------------------

function coordMSE(pred: THREE.Vector3[], truth: THREE.Vector3[]): number {
  let s = 0;
  for (let i = 0; i < pred.length; i++) {
    s += pred[i].distanceToSquared(truth[i]);
  }
  return s / pred.length;
}

function fape(
  pred: THREE.Vector3[],
  truth: THREE.Vector3[],
  dClamp: number,
): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < pred.length; i++) {
    const fPred = frameAt(pred, i);
    const fTrue = frameAt(truth, i);
    for (let j = 0; j < pred.length; j++) {
      const vp = toLocal(pred[j], fPred);
      const vt = toLocal(truth[j], fTrue);
      const d = vp.distanceTo(vt);
      s += Math.min(d, dClamp);
      n += 1;
    }
  }
  return s / n; // In units of length; normalized by d_clamp-equivalent scale in
  //              the real paper. We don't normalize here so readers can see
  //              raw magnitudes.
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

function buildPrediction(truth: THREE.Vector3[], rotDeg: number, perturb: number): THREE.Vector3[] {
    const perturbed = truth.map((p) => p.clone());
    const k = 8;
    const dir = new THREE.Vector3(0.0, 1.0, 0.5).normalize();
    perturbed[k].add(dir.multiplyScalar(perturb));

    const rotRad = (rotDeg * Math.PI) / 180;
    const rotMat = new THREE.Matrix3().set(
      Math.cos(rotRad),  0, Math.sin(rotRad),
      0,                 1, 0,
      -Math.sin(rotRad), 0, Math.cos(rotRad),
    );
    // Center of rotation: centroid of truth chain so rotation happens in place.
    const centroid = truth.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / truth.length);

    return perturbed.map((p) => {
      const v = p.clone().sub(centroid);
      v.applyMatrix3(rotMat);
      return v.add(centroid);
    });
}

export default function FAPEInvarianceDemo() {
  const [rotDeg, setRotDeg] = useState(0);
  const [perturb, setPerturb] = useState(0);

  const truth = useMemo(() => buildTrueChain(), []);

  // Build the predicted chain as:
  //   1. a local structural perturbation in the prediction's own frame;
  //   2. a global rigid rotation of the entire perturbed prediction.
  // This ordering keeps FAPE flat as the global-rotation slider moves, even
  // when the local perturbation is nonzero.
  const pred = useMemo(() => buildPrediction(truth, rotDeg, perturb), [truth, rotDeg, perturb]);
  const alignedFape = useMemo(() => fape(buildPrediction(truth, 0, perturb), truth, D_CLAMP), [truth, perturb]);

  const losses = useMemo(() => {
    return {
      mse: coordMSE(pred, truth),
      fape: fape(pred, truth, D_CLAMP),
    };
  }, [pred, truth]);

  return (
    <figure className="fape-root">
      <div className="fape-intro"><strong>Coordinate error and FAPE</strong><span>Rotate the chain or move residue 9.</span></div>
      <div className="fape-scenarios" role="group" aria-label="Compare prediction scenarios">
        {[
          { label: 'Match', description: 'Matching chains', rotation: 0, offset: 0 },
          { label: 'Rotate', description: 'Rotate the whole prediction', rotation: 90, offset: 0 },
          { label: 'Distort', description: 'Displace residue 9', rotation: 0, offset: 1 },
          { label: 'Both', description: 'Rotate the distorted prediction', rotation: 90, offset: 1 },
        ].map((scenario) => (
          <button key={scenario.label} type="button" aria-label={scenario.description} title={scenario.description} aria-pressed={rotDeg === scenario.rotation && perturb === scenario.offset}
            onClick={() => { setRotDeg(scenario.rotation); setPerturb(scenario.offset); }}>
            {scenario.label}
          </button>
        ))}
      </div>
      <div className="fape-stage">
        <div className="fape-canvas-wrap">
          <Canvas
            camera={{ position: [0, 2, 10], fov: 40 }}
            style={{ height: 340 }}
            dpr={[1, 2]}
          >
            <ambientLight intensity={0.4} />
            <directionalLight position={[3, 5, 4]} intensity={0.8} />
            <OrbitControls enablePan={false} />
            <ChainRenderer points={truth} color="#cbd2cd" radius={0.065} />
            <ChainRenderer points={pred} color="#a6c966" radius={0.09} />
            {perturb > 0 && <mesh position={pred[8].toArray()}>
              <sphereGeometry args={[0.21, 20, 20]} />
              <meshStandardMaterial color="#e8a45d" />
            </mesh>}
            <PerResidueSticks truth={truth} pred={pred} />
            <axesHelper args={[0.8]} />
          </Canvas>
          <div className="fape-legend">
            <span><i style={{ background: '#cbd2cd' }} /> Reference</span>
            <span><i style={{ background: '#a6c966' }} /> Prediction</span>
            {perturb > 0 && <span><i style={{ background: '#e8a45d' }} /> Residue 9</span>}
            <span>Drag to move the camera.</span>
          </div>
        </div>

        <div className="fape-panel">
          <div className="fape-sliders">
            <label className="fape-slider">
              <div className="fape-slider-label-row">
                <span>Global rotation</span>
                <span className="fape-slider-value">{rotDeg}°</span>
              </div>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={rotDeg}
                onChange={(e) => setRotDeg(Number(e.currentTarget.value))}
                aria-label="Global rotation of prediction"
              />
              <div className="fape-slider-caption">
                Whole prediction, around the vertical axis
              </div>
            </label>
            <label className="fape-slider">
              <div className="fape-slider-label-row">
                <span>Displacement of residue 9</span>
                <span className="fape-slider-value">{perturb.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.02}
                value={perturb}
                onChange={(e) => setPerturb(Number(e.currentTarget.value))}
                aria-label="Local perturbation on a single residue of the prediction"
              />
              <div className="fape-slider-caption">
                Moves the residue before the global rotation
              </div>
            </label>
            <button
              type="button"
              className="fape-reset"
              onClick={() => {
                setRotDeg(0);
                setPerturb(0);
              }}
            >
              Reset
            </button>
          </div>
          <div className="fape-losses">
            <div className="fape-loss-item">
              <div className="fape-loss-label">Coordinate MSE</div>
              <div className="fape-loss-value fape-loss-value--mse">
                {losses.mse.toFixed(3)}
              </div>
              <div className="fape-loss-hint">
                World coordinates · length²
              </div>
            </div>
            <div className="fape-loss-item">
              <div className="fape-loss-label">FAPE</div>
              <div className="fape-loss-value fape-loss-value--fape">
                {losses.fape.toFixed(3)}
              </div>
              <div className="fape-loss-hint">
                Local frames · length
              </div>
            </div>
            <p className="fape-comparison">
              Before rotation: <strong>{alignedFape.toFixed(3)}</strong> · FAPE change: <strong>{Math.abs(losses.fape - alignedFape) < 1e-10 ? '< 10⁻¹⁰' : Math.abs(losses.fape - alignedFape).toExponential(2)}</strong>
            </p>
          </div>

        </div>
      </div>

      <figcaption className="fape-caption">
        Gray connectors show coordinate displacement, not FAPE. This Cα-only example uses arbitrary length
        units, a distance clamp of {D_CLAMP}, and no length normalization. The two losses have different units.
      </figcaption>

      <style>{`
        .fape-root {
          margin: 1.5rem 0;
          border: 1px solid var(--rule);
          border-radius: 6px;
          padding: 0.95rem 1rem 1rem;
          background: color-mix(in oklab, var(--bg) 94%, var(--rule) 6%);
          font-family: var(--font-sans);
        }
        .fape-intro { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.8rem; margin-bottom: 0.7rem; }
        .fape-intro strong { color: var(--fg); font-size: 0.95rem; }
        .fape-intro > span { color: var(--fg-muted); font-size: 0.77rem; }
        .fape-scenarios { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.75rem; }
        .fape-scenarios button { min-height: 2rem; padding: 0.4rem 0.75rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--surface-strong); color: var(--fg); font: inherit; font-size: 0.77rem; cursor: pointer; }
        .fape-scenarios button[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
        .fape-comparison { grid-column: 1 / -1; margin: 0 !important; color: var(--accent); font-size: 0.72rem; line-height: 1.6; }
        .fape-legend { display: flex; flex-wrap: wrap; gap: 0.45rem 0.9rem; padding: 0.75rem; color: #e5ebdd; font-size: 0.71rem; line-height: 1.5; }
        .fape-legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
        .fape-legend i { width: 0.65rem; height: 0.65rem; border-radius: 50%; }
        .fape-legend span:last-child { flex-basis: 100%; color: #bccabd; }
        .fape-stage {
          display: grid;
          grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
          gap: 1rem;
          align-items: start;
        }
        @media (max-width: 720px) {
          .fape-stage {
            grid-template-columns: 1fr;
          }
        }
        .fape-canvas-wrap {
          border: 1px solid var(--rule);
          border-radius: 4px;
          overflow: hidden;
          background: #142722;
          min-height: 340px;
        }
        .fape-panel {
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
        }

        /* Loss readouts */
        .fape-losses {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 0.65rem;
        }
        .fape-loss-item {
          border: 1px solid var(--rule);
          border-radius: 4px;
          padding: 0.55rem 0.7rem;
          background: color-mix(in oklab, var(--bg) 88%, var(--rule) 12%);
        }
        .fape-loss-label {
          font-size: 0.65rem;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          color: var(--fg-muted);
        }
        .fape-loss-value {
          font-family: var(--font-mono);
          font-size: 1.4rem;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          margin-top: 0.15rem;
          min-width: 4rem;
          display: inline-block;
        }
        .fape-loss-value--mse { color: #a25a25; }
        .fape-loss-value--fape { color: var(--accent); }
        .fape-loss-hint {
          font-size: 0.72rem;
          color: var(--fg-muted);
          margin-top: 0.3rem;
        }
        .fape-loss-hint em { font-style: italic; color: var(--fg); }

        /* Sliders */
        .fape-sliders {
          display: flex;
          flex-direction: column;
          gap: 0.7rem;
        }
        .fape-slider {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .fape-slider-label-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          font-size: 0.82rem;
          color: var(--fg);
        }
        .fape-slider-value {
          font-family: var(--font-mono);
          color: var(--accent);
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          min-width: 3.2rem;
          text-align: right;
        }
        .fape-slider input[type='range'] {
          min-height: 1.6rem;
          width: 100%;
          accent-color: var(--accent);
        }
        .fape-slider-caption {
          font-size: 0.72rem;
          color: var(--fg-muted);
        }
        .fape-reset {
          align-self: flex-start;
          padding: 0.4rem 0.7rem;
          min-height: 2.4rem;
          border: 1px solid var(--rule);
          border-radius: 4px;
          background: transparent;
          font: inherit;
          font-size: 0.8rem;
          color: var(--fg);
          cursor: pointer;
        }
        .fape-reset:hover { border-color: var(--fg-muted); }

        /* Caption */
        .fape-caption {
          margin-top: 0.85rem;
          font-size: 0.76rem;
          line-height: 1.55;
          color: var(--fg-muted);
        }
        .fape-caption strong { color: var(--fg); }
        .fape-caption em { font-style: italic; color: var(--fg); }
      `}</style>
    </figure>
  );
}

// -----------------------------------------------------------------------------
// Three.js helpers
// -----------------------------------------------------------------------------

function ChainRenderer({
  points,
  color,
  radius,
}: {
  points: THREE.Vector3[];
  color: string;
  radius: number;
}) {
  return (
    <>
      {points.map((p, i) => (
        <mesh key={`r-${i}`} position={[p.x, p.y, p.z]}>
          <sphereGeometry args={[radius * 2, 16, 16]} />
          <meshStandardMaterial color={color} roughness={0.5} />
        </mesh>
      ))}
      {points.slice(0, -1).map((p, i) => {
        const q = points[i + 1];
        const mid = p.clone().add(q).multiplyScalar(0.5);
        const dir = q.clone().sub(p);
        const len = dir.length();
        const up = new THREE.Vector3(0, 1, 0);
        const axis = new THREE.Vector3().crossVectors(up, dir.clone().normalize());
        const angle = Math.acos(up.dot(dir.clone().normalize()));
        const quat = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
        return (
          <mesh
            key={`b-${i}`}
            position={[mid.x, mid.y, mid.z]}
            quaternion={[quat.x, quat.y, quat.z, quat.w]}
          >
            <cylinderGeometry args={[radius, radius, len, 8]} />
            <meshStandardMaterial color={color} roughness={0.5} />
          </mesh>
        );
      })}
    </>
  );
}

// Per-residue connectors show coordinate-space displacement, not FAPE.
function PerResidueSticks({ truth, pred }: { truth: THREE.Vector3[]; pred: THREE.Vector3[] }) {
  return (
    <>
      {truth.map((t, i) => {
        const p = pred[i];
        if (t.distanceTo(p) < 0.02) return null;
        const mid = t.clone().add(p).multiplyScalar(0.5);
        const dir = p.clone().sub(t);
        const len = dir.length();
        const up = new THREE.Vector3(0, 1, 0);
        const axis = new THREE.Vector3().crossVectors(up, dir.clone().normalize());
        const angle = Math.acos(Math.max(-1, Math.min(1, up.dot(dir.clone().normalize()))));
        const quat = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
        return (
          <mesh
            key={`stick-${i}`}
            position={[mid.x, mid.y, mid.z]}
            quaternion={[quat.x, quat.y, quat.z, quat.w]}
          >
            <cylinderGeometry args={[0.02, 0.02, len, 6]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.35} />
          </mesh>
        );
      })}
    </>
  );
}
