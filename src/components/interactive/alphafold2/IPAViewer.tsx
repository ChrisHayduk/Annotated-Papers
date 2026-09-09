import { Canvas } from '@react-three/fiber';
import { OrbitControls, Line } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';

/** A simplified IPA distance score on residue origins. Rigid transformations
 * are applied to positions AND local frames before attention is recomputed.
 * The scalar Q·K and pair-bias terms of full IPA are omitted. */

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
  showFrames,
}: {
  chain: Residue[];
  queryIdx: number;
  setQueryIdx: (i: number) => void;
  weights: number[];
  topIndices: Set<number>;
  showFrames: boolean;
}) {
  // Normalize against the top-1 weight so the thickest line always hits the
  // visual top of the scale, no matter how sharp or flat the overall
  // distribution is.
  const topWeight = Math.max(...Array.from(topIndices).map((i) => weights[i]), 1e-6);
  const qPos = chain[queryIdx].position;

  return (
    <group>
      {/* Connecting backbone line */}
      <Line
        points={chain.map((r) => r.position.toArray() as [number, number, number])}
        color="#64716b"
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
            color="#1e6750"
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
                color={isQuery ? '#b55f2c' : inTop ? '#a6c966' : '#88998d'}
                emissive={isQuery ? '#412713' : '#000000'}
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
  const referenceChain = useMemo(buildChain, []);
  const [queryIdx, setQueryIdx] = useState(6);
  const [rotDeg, setRotDeg] = useState(0);
  const [shift, setShift] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showFrames, setShowFrames] = useState(false);
  const chooseQuery = (index: number) => { setPlaying(false); setQueryIdx(index); };
  const choosePose = (degrees: number, translation: number) => {
    setPlaying(false); setRotDeg(degrees); setShift(translation);
  };

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pauseForPreference = () => { if (preference.matches) setPlaying(false); };
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false); };
    pauseForPreference();
    preference.addEventListener('change', pauseForPreference);
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      preference.removeEventListener('change', pauseForPreference);
      document.removeEventListener('visibilitychange', pauseWhenHidden);
    };
  }, []);

  // Animate the actual rigid transformation, then recompute attention from
  // the transformed positions and frames. Camera motion is a separate action.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      if (!last) last = time;
      const elapsed = time - last;
      if (elapsed >= 32) {
        setRotDeg((degrees) => (degrees + Math.min(elapsed, 100) * 0.028) % 360);
        last = time;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const chain = useMemo(() => {
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotDeg * Math.PI / 180);
    const translation = new THREE.Vector3(0.45, 0.25, -0.3).multiplyScalar(shift);
    return referenceChain.map((residue) => ({
      position: residue.position.clone().applyQuaternion(rotation).add(translation),
      quaternion: rotation.clone().multiply(residue.quaternion),
    }));
  }, [referenceChain, rotDeg, shift]);
  const referenceWeights = useMemo(() => computeAttention(referenceChain, queryIdx), [referenceChain, queryIdx]);
  const weights = useMemo(() => computeAttention(chain, queryIdx), [chain, queryIdx]);
  const maxWeightChange = Math.max(...weights.map((weight, i) => Math.abs(weight - referenceWeights[i])));
  const topK = useMemo(() => weights
    .map((w, i) => ({ i, w }))
    .filter((entry) => entry.i !== queryIdx)
    // Resolve numerical ties by index so an invariant animation does not
    // flicker between equal-weight keys at the top-five boundary.
    .sort((a, b) => Math.abs(a.w - b.w) < 1e-12 ? a.i - b.i : b.w - a.w)
    .slice(0, 5), [weights, queryIdx]);
  const topIndices = useMemo(() => new Set(topK.map((entry) => entry.i)), [topK]);

  return (
    <figure className="ipa-root">
      <div className="ipa-intro"><strong>Invariant point attention</strong><span>Click a residue, drag the scene, or rotate the chain.</span></div>
      <div className="ipa-experiment" role="group" aria-label="Rigid transformation controls">
        <button type="button" onClick={() => setPlaying((current) => !current)} aria-pressed={playing}>
          {playing ? 'Pause rotation' : 'Play rotation'}
        </button>
        <button type="button" onClick={() => choosePose(0, 0)}>Reset</button>
        <button type="button" onClick={() => choosePose(90, 1)}>Rotate + translate</button>
      </div>
      <div className="ipa-layout">
        <div className="ipa-canvas" onPointerDown={() => setPlaying(false)}>
          <Canvas camera={{ position: [5, 1.8, 5], fov: 42 }}>
            <ambientLight intensity={0.55} />
            <directionalLight position={[4, 6, 5]} intensity={0.7} />
            <ChainScene chain={chain} queryIdx={queryIdx} setQueryIdx={chooseQuery} weights={weights} topIndices={topIndices} showFrames={showFrames} />
            <OrbitControls makeDefault target={[0, 0.4, 0]} enablePan={false} enableDamping onStart={() => setPlaying(false)} />
          </Canvas>
          <div className="ipa-hud">Orange: query {queryIdx + 1} · Green: strongest connections</div>
          <div className="ipa-canvas-controls">
            <label><input type="checkbox" checked={showFrames} onChange={(event) => { setPlaying(false); setShowFrames(event.currentTarget.checked); }} /> Local axes</label>
            {showFrames && <span>x red · y green · z blue</span>}
          </div>
        </div>
        <div className="ipa-panel">
          <label className="ipa-query"><span>Query residue</span>
            <select value={queryIdx} onChange={(event) => chooseQuery(Number(event.currentTarget.value))}>
              {referenceChain.map((_, i) => <option key={i} value={i}>Residue {i + 1} (i = {i})</option>)}
            </select>
          </label>
          <label className="ipa-slider">
            <span>Global rotation <output>{rotDeg.toFixed(0)}°</output></span>
            <input type="range" min={0} max={360} step={1} value={rotDeg} onChange={(event) => { setPlaying(false); setRotDeg(Number(event.currentTarget.value)); }} aria-label="Global rotation of the IPA chain" />
          </label>
          <label className="ipa-slider">
            <span>Global translation <output>{shift.toFixed(2)}</output></span>
            <input type="range" min={0} max={1} step={0.01} value={shift} onChange={(event) => { setPlaying(false); setShift(Number(event.currentTarget.value)); }} aria-label="Global translation of the IPA chain" />
          </label>
          <div className="ipa-weights">
            <div className="ipa-weights-head">Top five weights · click to change query</div>
            {topK.map(({ i, w }) => (
              <button key={i} type="button" className="ipa-weight-row" onClick={() => chooseQuery(i)} aria-label={`Use residue ${i + 1} as query; current attention weight ${(100 * w).toFixed(1)} percent`}>
                <span className="ipa-weight-j">→ {i + 1}</span>
                <span className="ipa-weight-track"><span className="ipa-weight-bar" style={{ width: `${(w / topK[0].w * 100).toFixed(1)}%` }} /></span>
                <span className="ipa-weight-val">{(100 * w).toFixed(1)}%</span>
              </button>
            ))}
          </div>
          <div className="ipa-result" role="status" aria-live={playing ? 'off' : 'polite'}>
            Max weight change after rigid motion: <strong>{maxWeightChange < 1e-12 ? '< 10⁻¹²' : maxWeightChange.toExponential(2)}</strong>
          </div>
        </div>
      </div>
      <figcaption className="ipa-note">
        The demo rotates or translates both positions and local frames, then recomputes the weights.
        This toy score uses residue-origin distances and a sequence penalty, not full IPA's learned points,
        scalar term, or pair bias. Bars scale to the largest weight; percentages include all 13 other residues.
      </figcaption>
      <style>{`
        .ipa-root { margin: 1.5rem 0; border: 1px solid var(--rule); border-radius: 6px; padding: 0.9rem 1rem 1rem; background: color-mix(in oklab, var(--bg) 94%, var(--rule) 6%); font-family: var(--font-sans); }
        .ipa-intro { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.8rem; margin-bottom: 0.7rem; }
        .ipa-intro strong { font-size: 0.95rem; color: var(--fg); }
        .ipa-intro > span { font-size: 0.77rem; color: var(--fg-muted); }
        .ipa-experiment { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.75rem; }
        .ipa-experiment button { min-height: 2rem; padding: 0.4rem 0.65rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--surface-strong); color: var(--fg); font: inherit; font-size: 0.77rem; cursor: pointer; }
        .ipa-experiment button:first-child { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
        .ipa-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
        @media (min-width: 760px) { .ipa-layout { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); } }
        .ipa-canvas { position: relative; height: 420px; border-radius: 4px; background: linear-gradient(180deg, color-mix(in oklab, var(--bg) 88%, var(--rule) 12%), var(--bg)); overflow: hidden; touch-action: none; }
        .ipa-hud { position: absolute; top: 0.65rem; left: 0.7rem; right: 0.7rem; color: var(--fg-muted); font-size: 0.71rem; line-height: 1.5; pointer-events: none; }
        .ipa-canvas-controls { position: absolute; bottom: 0.65rem; left: 0.7rem; right: 0.7rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.7rem; color: var(--fg-muted); font-size: 0.71rem; }
        .ipa-canvas-controls label { display: inline-flex; align-items: center; gap: 0.35rem; cursor: pointer; }
        .ipa-panel { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
        .ipa-query { display: grid; gap: 0.3rem; font-size: 0.77rem; color: var(--fg-muted); }
        .ipa-query select { width: 100%; min-height: 2.2rem; padding: 0.35rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--surface-strong); color: var(--fg); font: inherit; }
        .ipa-slider { display: grid; gap: 0.2rem; color: var(--fg-muted); font-size: 0.77rem; }
        .ipa-slider > span { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
        .ipa-slider output { color: var(--accent); font-family: var(--font-mono); }
        .ipa-slider input { min-width: 0; width: 100%; min-height: 1.5rem; accent-color: var(--accent); }
        .ipa-weights-head { margin-bottom: 0.3rem; color: var(--fg-muted); font-size: 0.71rem; }
        .ipa-weight-row { display: grid; width: 100%; grid-template-columns: 2.2rem minmax(0, 1fr) 3.2rem; align-items: center; gap: 0.5rem; padding: 0.35rem 0.2rem; border: 0; border-radius: 3px; background: transparent; font: 0.76rem var(--font-mono); cursor: pointer; }
        .ipa-weight-row:hover { background: var(--accent-soft); }
        .ipa-weight-j { color: var(--fg); text-align: left; }
        .ipa-weight-track { display: block; height: 9px; overflow: hidden; background: var(--rule); border-radius: 2px; }
        .ipa-weight-bar { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
        .ipa-weight-val { text-align: right; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
        .ipa-result { padding-top: 0.5rem; border-top: 1px solid var(--rule); font-size: 0.72rem; line-height: 1.5; color: var(--fg-muted); }
        .ipa-result strong { color: var(--accent); white-space: nowrap; }
        .ipa-note { margin-top: 0.8rem; color: var(--fg-muted); font-size: 0.76rem; line-height: 1.55; }
      `}</style>
    </figure>
  );
}
