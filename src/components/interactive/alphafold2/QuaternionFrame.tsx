import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Component, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * QuaternionFrame — a live demo of the quaternion -> rotation matrix map.
 *
 * Four sliders control the components (w, x, y, z) of a quaternion. We render
 * both the implicitly-normalized rotation matrix and a 3D scene containing
 * two coordinate frames: a static world frame (thin gray) and a local frame
 * (thick red/green/blue) rotated by the current quaternion.
 *
 * The point of the widget is to make the quaternion -> rotation map concrete.
 * Readers who've only used Euler angles often don't have intuition for
 * quaternions; letting them drag sliders and see the rotation matrix update
 * in real time is a lot more direct than writing the formula on the page.
 *
 * Implementation notes:
 *   - Axes are drawn as thin cylinder meshes rather than <Line /> primitives;
 *     <Line /> is backed by LineMaterial whose thickness depends on a
 *     resolution uniform and renders inconsistently across GPUs.
 *   - We pass the quaternion to r3f as a plain [x, y, z, w] tuple. r3f
 *     reconciles tuples by calling .set() on the existing THREE.Quaternion
 *     attached to the group, which is far more robust under rapid updates
 *     than creating a new THREE.Quaternion each render and handing it in.
 *   - The rendered tree is wrapped in an error boundary so that any three.js
 *     exception shows a legible fallback rather than blanking the component.
 */

type Q = { w: number; x: number; y: number; z: number };
type QuatTuple = [number, number, number, number]; // three.js order: (x, y, z, w)

const IDENTITY: Q = { w: 1, x: 0, y: 0, z: 0 };

function normalize(q: Q): Q {
  const n = Math.hypot(q.w, q.x, q.y, q.z);
  if (!Number.isFinite(n) || n < 1e-6) return IDENTITY;
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

function toTuple(q: Q): QuatTuple {
  const qn = normalize(q);
  return [qn.x, qn.y, qn.z, qn.w];
}

function quatToMat3(q: Q): number[][] {
  const { w, x, y, z } = normalize(q);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

type AxisName = 'x' | 'y' | 'z';
const AXIS_COLORS: Record<AxisName, string> = {
  x: '#e64b5c',
  y: '#4ea15e',
  z: '#4e7ee8',
};
// Rotations to re-aim a default +Y-up cylinder/cone so it extends along +X, +Y, or +Z.
const AXIS_ROTATIONS: Record<AxisName, [number, number, number]> = {
  x: [0, 0, -Math.PI / 2],
  y: [0, 0, 0],
  z: [Math.PI / 2, 0, 0],
};

function axisCenter(axis: AxisName, offset: number): [number, number, number] {
  return axis === 'x' ? [offset, 0, 0] : axis === 'y' ? [0, offset, 0] : [0, 0, offset];
}

function AxisCylinder({
  axis,
  length,
  radius,
  opacity,
}: {
  axis: AxisName;
  length: number;
  radius: number;
  opacity: number;
}) {
  const isOpaque = opacity >= 0.999;
  return (
    <mesh position={axisCenter(axis, length / 2)} rotation={AXIS_ROTATIONS[axis]}>
      <cylinderGeometry args={[radius, radius, length, 10]} />
      <meshBasicMaterial
        color={AXIS_COLORS[axis]}
        transparent={!isOpaque}
        opacity={opacity}
        toneMapped={false}
      />
    </mesh>
  );
}

function AxisTip({ axis, length }: { axis: AxisName; length: number }) {
  return (
    <mesh position={axisCenter(axis, length)} rotation={AXIS_ROTATIONS[axis]}>
      <coneGeometry args={[0.05, 0.13, 10]} />
      <meshBasicMaterial color={AXIS_COLORS[axis]} toneMapped={false} />
    </mesh>
  );
}

function Axes({
  quat,
  scale,
  opacity,
  radius,
  withTips = false,
}: {
  quat: QuatTuple;
  scale: number;
  opacity: number;
  radius: number;
  withTips?: boolean;
}) {
  return (
    <group quaternion={quat}>
      <AxisCylinder axis="x" length={scale} radius={radius} opacity={opacity} />
      <AxisCylinder axis="y" length={scale} radius={radius} opacity={opacity} />
      <AxisCylinder axis="z" length={scale} radius={radius} opacity={opacity} />
      {withTips && (
        <>
          <AxisTip axis="x" length={scale} />
          <AxisTip axis="y" length={scale} />
          <AxisTip axis="z" length={scale} />
        </>
      )}
    </group>
  );
}

function AttachedBox({ quat }: { quat: QuatTuple }) {
  return (
    <group quaternion={quat}>
      <mesh position={[0.95, 0, 0]}>
        <boxGeometry args={[0.5, 0.28, 0.28]} />
        <meshStandardMaterial color="#a8adb5" metalness={0.1} roughness={0.55} />
      </mesh>
    </group>
  );
}

function Scene({ q }: { q: Q }) {
  const localQuat = toTuple(q);
  const worldQuat: QuatTuple = [0, 0, 0, 1];
  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[5, 5, 5]} intensity={0.4} />
      <Axes quat={worldQuat} scale={1.0} opacity={0.28} radius={0.012} />
      <Axes quat={localQuat} scale={1.4} opacity={1} radius={0.028} withTips />
      <AttachedBox quat={localQuat} />
      <OrbitControls makeDefault enablePan={false} enableDamping />
    </>
  );
}

// ---------------------------------------------------------------------------
// Error boundary: if anything inside <Canvas> throws (GL context lost, scene
// reconciler error, etc.), show a legible fallback rather than blanking.
// ---------------------------------------------------------------------------

interface BoundaryState {
  err: Error | null;
}
class CanvasBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { err: null };
  static getDerivedStateFromError(err: Error): BoundaryState {
    return { err };
  }
  componentDidCatch(err: Error) {
    // Dev-visibility: surface the error in the console so we can see what
    // three.js is actually complaining about, without blowing up the page.
    // eslint-disable-next-line no-console
    console.error('[QuaternionFrame] scene error:', err);
  }
  render() {
    if (this.state.err) {
      return (
        <div className="qf-fallback">
          <p>The 3D view couldn't render.</p>
          <p>
            <button onClick={() => this.setState({ err: null })} className="qf-btn">Retry</button>
          </p>
          <p className="qf-fallback-err">{this.state.err.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function QuaternionFrame() {
  const [q, setQ] = useState<Q>(IDENTITY);
  const qn = normalize(q);
  const rawNorm = Math.hypot(q.w, q.x, q.y, q.z);
  const M = quatToMat3(q);

  const setK = (k: keyof Q) => (e: React.ChangeEvent<HTMLInputElement>) => {
    // Capture the value synchronously *before* we enter the functional setState
    // updater. React 18's concurrent mode can invoke the updater multiple times
    // across renders, and by the later invocations the synthetic event may have
    // been released and `e.currentTarget` is null — reading `.value` on that
    // throws and takes down the Canvas with it. Reading the value once up front
    // sidesteps the whole issue.
    const value = Number(e.currentTarget.value);
    if (!Number.isFinite(value)) return;
    setQ((prev) => ({ ...prev, [k]: value }));
  };

  return (
    <figure className="qf-root">
      <div className="qf-layout">
        <div className="qf-canvas">
          <CanvasBoundary>
            <Canvas
              camera={{ position: [2.5, 1.7, 2.5], fov: 42 }}
              dpr={[1, 2]}
              gl={{ antialias: true, preserveDrawingBuffer: false }}
            >
              <Scene q={q} />
            </Canvas>
          </CanvasBoundary>
          <div className="qf-legend">
            <span><span className="qf-sw qf-sw--x" /> local x</span>
            <span><span className="qf-sw qf-sw--y" /> local y</span>
            <span><span className="qf-sw qf-sw--z" /> local z</span>
            <span className="qf-legend-muted">(faded = world frame)</span>
          </div>
        </div>

        <div className="qf-panel">
          <div className="qf-sliders">
            {(['w', 'x', 'y', 'z'] as const).map((k) => (
              <label key={k} className="qf-slider">
                <span className="qf-slider-k">{k}</span>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={q[k]}
                  onChange={setK(k)}
                  aria-label={`Quaternion ${k} component`}
                />
                <span className="qf-slider-val">{q[k].toFixed(2)}</span>
              </label>
            ))}
          </div>

          <div className="qf-norm">
            <span>‖q‖ = {rawNorm.toFixed(3)}</span>
            <span className="qf-norm-sep">→ normalized:</span>
            <code>({qn.w.toFixed(2)}, {qn.x.toFixed(2)}, {qn.y.toFixed(2)}, {qn.z.toFixed(2)})</code>
          </div>

          <div className="qf-matrix" aria-label="Rotation matrix derived from quaternion">
            <div className="qf-matrix-label">R(q) =</div>
            <div className="qf-matrix-grid">
              {M.flat().map((v, i) => (
                <span key={i} className={`qf-cell ${v >= 0 ? 'qf-cell-pos' : 'qf-cell-neg'}`}>
                  {v >= 0 ? '\u00A0' : ''}{v.toFixed(2)}
                </span>
              ))}
            </div>
          </div>

          <div className="qf-presets">
            <button type="button" onClick={() => setQ(IDENTITY)} className="qf-btn">Identity</button>
            <button type="button" onClick={() => setQ(normalize(q))} className="qf-btn">Normalize</button>
            <button
              type="button"
              onClick={() => setQ({ w: Math.SQRT1_2, x: Math.SQRT1_2, y: 0, z: 0 })}
              className="qf-btn"
            >
              90° about X
            </button>
            <button
              type="button"
              onClick={() => setQ({ w: Math.SQRT1_2, x: 0, y: Math.SQRT1_2, z: 0 })}
              className="qf-btn"
            >
              90° about Y
            </button>
            <button
              type="button"
              onClick={() => setQ({ w: 0.5, x: 0.5, y: 0.5, z: 0.5 })}
              className="qf-btn"
            >
              120° diag
            </button>
          </div>
        </div>
      </div>

      <figcaption className="qf-caption">
        Drag inside the scene to rotate the camera. Adjust the sliders to change the quaternion; the matrix, the
        local frame, and the attached cube all update live. Only the direction of <em>q</em> matters — the
        rotation is unchanged if you scale all four components uniformly, since we always normalize (and treat
        the zero quaternion as the identity).
      </figcaption>

      <style>{`
        .qf-root {
          margin: 1.5rem 0;
          border: 1px solid var(--rule);
          border-radius: 6px;
          padding: 0.9rem 1rem 1rem;
          background: color-mix(in oklab, var(--bg) 94%, var(--rule) 6%);
          font-family: var(--font-sans);
        }
        .qf-layout {
          display: grid;
          grid-template-columns: 1fr;
          gap: 1rem;
        }
        @media (min-width: 720px) {
          .qf-layout { grid-template-columns: 1.1fr 1fr; }
        }
        .qf-canvas {
          position: relative;
          height: 340px;
          border-radius: 4px;
          background: linear-gradient(180deg, color-mix(in oklab, var(--bg) 85%, var(--rule) 15%), var(--bg));
          overflow: hidden;
          touch-action: none;
        }
        .qf-canvas > div:first-child,
        .qf-canvas canvas {
          width: 100% !important;
          height: 100% !important;
        }
        .qf-legend {
          position: absolute;
          bottom: 0.6rem;
          left: 0.7rem;
          display: flex;
          gap: 0.8rem;
          font-size: 0.72rem;
          color: var(--fg-muted);
          align-items: center;
          pointer-events: none;
        }
        .qf-legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
        .qf-sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
        .qf-sw--x { background: #e64b5c; }
        .qf-sw--y { background: #4ea15e; }
        .qf-sw--z { background: #4e7ee8; }
        .qf-legend-muted { font-style: italic; opacity: 0.8; }

        .qf-fallback {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 0.5rem;
          padding: 1rem;
          font-size: 0.85rem;
          color: var(--fg-muted);
          text-align: center;
        }
        .qf-fallback p { margin: 0; }
        .qf-fallback-err {
          font-family: var(--font-mono);
          font-size: 0.72rem;
          opacity: 0.7;
        }

        .qf-panel {
          display: flex;
          flex-direction: column;
          gap: 0.9rem;
          font-size: 0.88rem;
        }
        .qf-sliders { display: flex; flex-direction: column; gap: 0.35rem; }
        .qf-slider {
          display: grid;
          grid-template-columns: 1.2rem 1fr 2.5rem;
          align-items: center;
          gap: 0.6rem;
          font-family: var(--font-mono);
        }
        .qf-slider-k { font-weight: 600; color: var(--accent); }
        .qf-slider-val { font-size: 0.8rem; color: var(--fg-muted); text-align: right; }

        .qf-norm {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem 0.75rem;
          align-items: baseline;
          font-size: 0.82rem;
          color: var(--fg-muted);
        }
        .qf-norm code { color: var(--fg); }
        .qf-norm-sep { font-style: italic; opacity: 0.7; }

        .qf-matrix {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          padding: 0.5rem 0.6rem;
          border: 1px solid var(--rule);
          border-radius: 4px;
          background: color-mix(in oklab, var(--bg) 90%, var(--rule) 10%);
        }
        .qf-matrix-label {
          font-family: var(--font-mono);
          font-size: 0.8rem;
          color: var(--fg-muted);
        }
        .qf-matrix-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.15rem 0.7rem;
          font-family: var(--font-mono);
          font-size: 0.9rem;
        }
        .qf-cell { text-align: right; tab-size: 2; font-variant-numeric: tabular-nums; }
        .qf-cell-pos { color: var(--fg); }
        .qf-cell-neg { color: var(--accent); }

        .qf-presets { display: flex; flex-wrap: wrap; gap: 0.35rem; }
        .qf-btn {
          font-size: 0.78rem;
          padding: 0.25rem 0.6rem;
          border: 1px solid var(--rule);
          border-radius: 3px;
          background: transparent;
          color: var(--fg);
          cursor: pointer;
        }
        .qf-btn:hover { border-color: var(--fg-muted); }

        .qf-caption {
          margin-top: 0.9rem;
          font-size: 0.86rem;
          color: var(--fg-muted);
          line-height: 1.5;
        }
      `}</style>
    </figure>
  );
}
