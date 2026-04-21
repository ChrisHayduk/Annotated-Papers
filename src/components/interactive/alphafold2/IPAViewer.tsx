import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Line } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * IPAViewer — a minimal visualization of the central SE(3) claim behind
 * Invariant Point Attention. We lay out a short synthetic chain of "residues"
 * in 3D (positions + local frames), and for a user-chosen query residue we
 * compute attention weights to every other residue using a distance-based
 * score evaluated *in the query's local frame*:
 *
 *    s(i, j) = -‖ T_i^{-1} · t_j ‖² / σ²  +  (sequence-distance penalty)
 *
 * Attention weights are then a softmax over j. The weights are drawn as
 * connecting lines whose thickness and opacity scale with the weight.
 *
 * The pedagogical point is the "rotate scene" toggle. When the scene is
 * auto-rotating, the connecting lines rotate *along with* the residues, but
 * their thicknesses don't change — the attention pattern is an invariant of
 * the configuration, not of the viewer's orientation. That is the SE(3)
 * invariance of IPA made visible.
 *
 * The score function here is a stand-in for the real three-term IPA score
 * (scalar Q·K, pair bias, point-distance term). We drop the first two terms
 * since they aren't pedagogically illuminating in a synthetic demo, and we
 * keep the point-distance term because that's the one that carries the
 * geometric story.
 */

const N = 14;
const SIGMA = 1.6;

type Residue = { position: THREE.Vector3; quaternion: THREE.Quaternion };

// Build a synthetic "chain" of residues along a gentle helix. Each residue's
// local frame is aligned to (tangent, normal, binormal) of the helix, which
// is a reasonable-looking stand-in for backbone frames.
function buildChain(): Residue[] {
  const chain: Residue[] = [];
  const pitch = 0.42;
  const radius = 0.85;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1) * Math.PI * 2.4;
    const pos = new THREE.Vector3(
      radius * Math.cos(t),
      -1.3 + t * pitch,
      radius * Math.sin(t),
    );
    // Tangent = derivative of the helix parametrisation
    const tangent = new THREE.Vector3(
      -radius * Math.sin(t),
      pitch,
      radius * Math.cos(t),
    ).normalize();
    // Normal points toward the helix axis
    const normal = new THREE.Vector3(-Math.cos(t), 0, -Math.sin(t)).normalize();
    // Binormal is orthogonal to both
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    // Build rotation matrix from (tangent = x, normal = y, binormal = z)
    const m = new THREE.Matrix4().makeBasis(tangent, normal, binormal);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    chain.push({ position: pos, quaternion: q });
  }
  return chain;
}

function computeAttention(chain: Residue[], queryIdx: number): number[] {
  // Bring each key's position into the query's local frame, then compute a
  // squared-distance penalty. Add a mild sequence-distance penalty so the
  // pattern doesn't just reduce to "nearest in 3D".
  const q = chain[queryIdx];
  const inv = q.quaternion.clone().invert();
  const scores: number[] = [];
  for (let j = 0; j < chain.length; j++) {
    if (j === queryIdx) {
      scores.push(-Infinity);
      continue;
    }
    const d = chain[j].position.clone().sub(q.position).applyQuaternion(inv);
    const point = -d.lengthSq() / (SIGMA * SIGMA);
    const seq = -Math.abs(j - queryIdx) * 0.08;
    scores.push(point + seq);
  }
  // Softmax
  const maxS = Math.max(...scores.filter((x) => Number.isFinite(x)));
  const exps = scores.map((s) => (Number.isFinite(s) ? Math.exp(s - maxS) : 0));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

function MiniAxes({ quaternion, scale = 0.22, opacity = 1 }: { quaternion: THREE.Quaternion; scale?: number; opacity?: number }) {
  return (
    <group quaternion={quaternion}>
      <Line points={[[0, 0, 0], [scale, 0, 0]]} color="#e64b5c" lineWidth={1.5} transparent opacity={opacity} />
      <Line points={[[0, 0, 0], [0, scale, 0]]} color="#4ea15e" lineWidth={1.5} transparent opacity={opacity} />
      <Line points={[[0, 0, 0], [0, 0, scale]]} color="#4e7ee8" lineWidth={1.5} transparent opacity={opacity} />
    </group>
  );
}

function ChainScene({
  chain,
  queryIdx,
  setQueryIdx,
  weights,
  topIndices,
  spinning,
  showFrames,
}: {
  chain: Residue[];
  queryIdx: number;
  setQueryIdx: (i: number) => void;
  weights: number[];
  topIndices: Set<number>;
  spinning: boolean;
  showFrames: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!groupRef.current) return;
    if (spinning) groupRef.current.rotation.y += dt * 0.35;
  });
  // Normalize against the top-1 weight so the thickest line always hits the
  // visual top of the scale, no matter how sharp or flat the overall
  // distribution is.
  const topWeight = Math.max(...Array.from(topIndices).map((i) => weights[i]), 1e-6);
  const qPos = chain[queryIdx].position;

  return (
    <group ref={groupRef}>
      {/* Connecting backbone line */}
      <Line
        points={chain.map((r) => r.position.toArray() as [number, number, number])}
        color="var(--fg-muted-fallback, #888)"
        lineWidth={1}
        transparent
        opacity={0.35}
      />

      {/* Attention lines: only to the top-K residues. */}
      {chain.map((r, j) => {
        if (j === queryIdx) return null;
        if (!topIndices.has(j)) return null;
        const w = weights[j];
        const rel = w / topWeight;
        return (
          <Line
            key={`att-${j}`}
            points={[qPos.toArray() as [number, number, number], r.position.toArray() as [number, number, number]]}
            color="#e8a1a1"
            lineWidth={1 + rel * 4.5}
            transparent
            opacity={0.35 + rel * 0.6}
          />
        );
      })}

      {/* Residues */}
      {chain.map((r, i) => {
        const isQuery = i === queryIdx;
        const inTop = topIndices.has(i);
        const w = weights[i];
        // Only the top-K residues pick up glow and size bumps — keeping the
        // visual message aligned with what the attention lines are saying.
        const rel = inTop ? w / topWeight : 0;
        const glow = isQuery ? 1 : rel;
        const scale = isQuery ? 0.17 : 0.11 + 0.05 * rel;
        return (
          <group key={`r-${i}`} position={r.position.toArray() as [number, number, number]}>
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                setQueryIdx(i);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = 'pointer';
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'default';
              }}
            >
              <sphereGeometry args={[scale, 20, 20]} />
              <meshStandardMaterial
                color={isQuery ? '#e64b5c' : '#a8adb5'}
                emissive={isQuery ? '#401418' : '#000000'}
                emissiveIntensity={glow * 0.6}
                metalness={0.2}
                roughness={0.5}
              />
            </mesh>
            {showFrames && <MiniAxes quaternion={r.quaternion} opacity={isQuery ? 1 : 0.45} />}
          </group>
        );
      })}
    </group>
  );
}

export default function IPAViewer() {
  const chain = useMemo(buildChain, []);
  const [queryIdx, setQueryIdx] = useState(6);
  const [spinning, setSpinning] = useState(true);
  const [showFrames, setShowFrames] = useState(true);

  // Respect reduced-motion: pause auto-rotation and let the user drive.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) setSpinning(false);
  }, []);

  const weights = useMemo(() => computeAttention(chain, queryIdx), [chain, queryIdx]);

  const topK = useMemo(() => {
    const idx = weights
      .map((w, i) => ({ i, w }))
      .filter((x) => x.i !== queryIdx)
      .sort((a, b) => b.w - a.w)
      .slice(0, 5);
    return idx;
  }, [weights, queryIdx]);

  const topIndices = useMemo(() => new Set(topK.map((e) => e.i)), [topK]);

  return (
    <figure className="ipa-root">
      <div className="ipa-layout">
        <div className="ipa-canvas">
          <Canvas camera={{ position: [3.2, 0.5, 3.2], fov: 42 }}>
            <ambientLight intensity={0.55} />
            <directionalLight position={[4, 6, 5]} intensity={0.7} />
            <ChainScene
              chain={chain}
              queryIdx={queryIdx}
              setQueryIdx={setQueryIdx}
              weights={weights}
              topIndices={topIndices}
              spinning={spinning}
              showFrames={showFrames}
            />
            <OrbitControls makeDefault enablePan={false} enableDamping />
          </Canvas>
          <div className="ipa-hud">
            Query residue: <strong>i = {queryIdx}</strong>
            <span className="ipa-hud-sep">•</span>
            Click any sphere to re-select
          </div>
        </div>

        <div className="ipa-panel">
          <div className="ipa-toggles">
            <label className="ipa-toggle">
              <input type="checkbox" checked={spinning} onChange={(e) => setSpinning(e.currentTarget.checked)} />
              <span>Auto-rotate scene</span>
            </label>
            <label className="ipa-toggle">
              <input type="checkbox" checked={showFrames} onChange={(e) => setShowFrames(e.currentTarget.checked)} />
              <span>Show local frames</span>
            </label>
          </div>

          <div className="ipa-weights">
            <div className="ipa-weights-head">Top attention from residue {queryIdx}</div>
            {topK.map(({ i, w }) => {
              const pct = w / topK[0].w;
              return (
                <div key={i} className="ipa-weight-row" onClick={() => setQueryIdx(i)}>
                  <span className="ipa-weight-j">→ {i}</span>
                  <span className="ipa-weight-bar" style={{ width: `${(pct * 100).toFixed(1)}%` }} />
                  <span className="ipa-weight-val">{w.toFixed(3)}</span>
                </div>
              );
            })}
          </div>

          <p className="ipa-note">
            The attention weight for <em>(i → j)</em> depends on <em>T<sub>i</sub><sup>−1</sup> · t<sub>j</sub></em>
            — the position of residue <em>j</em> as seen from residue <em>i</em>'s local frame. This is
            invariant under any global rotation of the chain, which is why the connecting lines thicken
            and fade <em>only</em> when you change the query, not when the scene spins.
          </p>
        </div>
      </div>

      <style>{`
        .ipa-root {
          margin: 1.5rem 0;
          border: 1px solid var(--rule);
          border-radius: 6px;
          padding: 0.9rem 1rem 1rem;
          background: color-mix(in oklab, var(--bg) 94%, var(--rule) 6%);
          font-family: var(--font-sans);
        }
        .ipa-layout {
          display: grid;
          grid-template-columns: 1fr;
          gap: 1rem;
        }
        @media (min-width: 760px) {
          .ipa-layout { grid-template-columns: 1.3fr 1fr; }
        }
        .ipa-canvas {
          position: relative;
          height: 420px;
          border-radius: 4px;
          background: linear-gradient(180deg, color-mix(in oklab, var(--bg) 88%, var(--rule) 12%), var(--bg));
          overflow: hidden;
          touch-action: none;
        }
        .ipa-hud {
          position: absolute;
          top: 0.55rem;
          left: 0.7rem;
          font-size: 0.78rem;
          color: var(--fg-muted);
          pointer-events: none;
        }
        .ipa-hud strong { color: var(--accent); font-weight: 600; }
        .ipa-hud-sep { margin: 0 0.4rem; opacity: 0.5; }

        .ipa-panel {
          display: flex;
          flex-direction: column;
          gap: 0.9rem;
          font-size: 0.88rem;
        }
        .ipa-toggles {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
        }
        .ipa-toggle {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          cursor: pointer;
          font-size: 0.85rem;
        }

        .ipa-weights {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          padding: 0.55rem 0.65rem;
          border: 1px solid var(--rule);
          border-radius: 4px;
        }
        .ipa-weights-head {
          font-size: 0.72rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--fg-muted);
          margin-bottom: 0.3rem;
        }
        .ipa-weight-row {
          display: grid;
          grid-template-columns: 2.2rem 1fr 3rem;
          align-items: center;
          gap: 0.5rem;
          cursor: pointer;
          font-family: var(--font-mono);
          font-size: 0.82rem;
          padding: 0.15rem 0;
        }
        .ipa-weight-row:hover { color: var(--accent); }
        .ipa-weight-j { color: var(--fg); }
        .ipa-weight-bar {
          display: inline-block;
          height: 8px;
          background: var(--accent);
          border-radius: 2px;
          opacity: 0.75;
        }
        .ipa-weight-val {
          text-align: right;
          color: var(--fg-muted);
          font-variant-numeric: tabular-nums;
        }

        .ipa-note {
          font-size: 0.82rem;
          line-height: 1.55;
          color: var(--fg-muted);
          margin: 0;
        }
      `}</style>
    </figure>
  );
}
