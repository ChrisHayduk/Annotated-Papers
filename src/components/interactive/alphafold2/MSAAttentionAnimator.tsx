import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

type Mode = 'row' | 'col';
type Query = { row: number; col: number };
const ORGANISMS = [
  { icon: '🧑', name: 'H. sapiens' },
  { icon: '🐴', name: 'E. caballus' },
  { icon: '🐔', name: 'G. gallus' },
  { icon: '🪰', name: 'D. melanogaster' },
  { icon: '🍄', name: 'S. cerevisiae' },
];
// Verbatim aligned columns 6–15 from the cytochrome c alignment in §1.2.
const MSA = [
  ['G', 'D', 'V', 'E', 'K', 'G', 'K', 'K', 'I', 'F'],
  ['G', 'D', 'V', 'E', 'K', 'G', 'K', 'K', 'I', 'F'],
  ['G', 'D', 'I', 'E', 'K', 'G', 'K', 'K', 'I', 'F'],
  ['G', 'D', 'V', 'E', 'K', 'G', 'K', 'K', 'L', 'F'],
  ['G', 'S', 'A', 'K', 'K', 'G', 'A', 'T', 'L', 'F'],
];
const ROWS = MSA.length;
const COLS = MSA[0].length;
const START = 6;
const INITIAL: Query = { row: 0, col: 2 };
const CELL = 36;
const COL_GAP = 24;
const ROW_GAP = 26;
const LEFT = 154;
const TOP = 58;
const WIDTH = LEFT + COLS * (CELL + COL_GAP) - COL_GAP + 34;
const HEIGHT = TOP + ROWS * (CELL + ROW_GAP) - ROW_GAP + 20;
const xy = (row: number, col: number) => ({ x: LEFT + col * (CELL + COL_GAP), y: TOP + row * (CELL + ROW_GAP) });
function nextQuery(query: Query, mode: Mode): Query {
  return mode === 'row'
    ? { row: (query.row + (query.col === COLS - 1 ? 1 : 0)) % ROWS, col: (query.col + 1) % COLS }
    : { row: (query.row + 1) % ROWS, col: (query.col + (query.row === ROWS - 1 ? 1 : 0)) % COLS };
}

/** Animated MSA attention. Connections indicate eligible keys, not weights. */
export default function MSAAttentionAnimator({ initialMode = 'row' }: { initialMode?: Mode } = {}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [query, setQuery] = useState<Query>(INITIAL);
  const [hover, setHover] = useState<Query | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(900);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const arrowId = `msa-arrow-${useId().replace(/:/g, '')}`;
  const select = (next: Query) => { setPlaying(false); setQuery(next); };

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => { setReduced(mq.matches); if (mq.matches) setPlaying(false); };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (rootRef.current) observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!playing || !visible) return;
    const timer = window.setInterval(() => setQuery(previous => nextQuery(previous, mode)), speed);
    return () => window.clearInterval(timer);
  }, [playing, visible, mode, speed]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const revealQuery = () => {
      const svg = viewport.querySelector('svg');
      if (!svg) return;
      const scale = svg.getBoundingClientRect().width / WIDTH;
      const left = xy(query.row, query.col).x * scale;
      const right = left + CELL * scale;
      const margin = 10;
      let scrollLeft = viewport.scrollLeft;
      if (left < scrollLeft + margin) scrollLeft = Math.max(0, left - margin);
      else if (right > scrollLeft + viewport.clientWidth - margin) scrollLeft = right - viewport.clientWidth + margin;
      if (Math.abs(scrollLeft - viewport.scrollLeft) > 1) viewport.scrollTo({ left: scrollLeft, behavior: reduced ? 'auto' : 'smooth' });
    };
    revealQuery();
    const observer = new ResizeObserver(revealQuery);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [query, reduced]);

  const keySelect = (event: KeyboardEvent<SVGGElement>, row: number, col: number) => {
    let next = { row, col };
    if (event.key === 'ArrowLeft') next.col = Math.max(0, col - 1);
    else if (event.key === 'ArrowRight') next.col = Math.min(COLS - 1, col + 1);
    else if (event.key === 'ArrowUp') next.row = Math.max(0, row - 1);
    else if (event.key === 'ArrowDown') next.row = Math.min(ROWS - 1, row + 1);
    else if (event.key === 'Home') next.col = 0;
    else if (event.key === 'End') next.col = COLS - 1;
    else if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select(next);
    event.currentTarget.ownerSVGElement?.querySelector<SVGGElement>(`[data-row="${next.row}"][data-col="${next.col}"]`)?.focus();
  };

  const origin = xy(query.row, query.col);
  const targets = mode === 'row'
    ? MSA[query.row].map((_, col) => ({ row: query.row, col }))
    : MSA.map((_, row) => ({ row, col: query.col }));
  const focus = hover ?? query;
  const eligibleCount = mode === 'row' ? COLS : ROWS;

  return <figure className={`msa-root${playing && !reduced ? ' msa-playing' : ''}`} ref={rootRef}>
    <div className="msa-title"><strong>Explore MSA attention</strong><span>Click a residue to choose the query.</span></div>
    <div className="msa-controls" role="group" aria-label="Attention and playback controls">
      <div className="msa-modes" role="group" aria-label="Attention direction">
        <button type="button" aria-pressed={mode === 'row'} onClick={() => { setMode('row'); setPlaying(false); }}>Row attention</button>
        <button type="button" aria-pressed={mode === 'col'} onClick={() => { setMode('col'); setPlaying(false); }}>Column attention</button>
      </div>
      <div className="msa-playback">
        <button type="button" onClick={() => setPlaying(value => !value)} aria-label={playing ? 'Pause animation' : 'Play animation'}>{playing ? 'Ⅱ Pause' : '▶ Play'}</button>
        <button type="button" onClick={() => select(nextQuery(query, mode))}>Step →</button>
        <button type="button" onClick={() => select(INITIAL)}>Reset</button>
      </div>
      <label className="msa-speed">Speed <select aria-label="Animation speed" value={speed} onChange={event => setSpeed(Number(event.currentTarget.value))}><option value={1600}>Slow</option><option value={900}>Normal</option><option value={400}>Fast</option></select></label>
    </div>
    <div className="msa-querybar">
      <label>Query <select aria-label="Query sequence" value={query.row} onChange={event => select({ ...query, row: Number(event.currentTarget.value) })}>{ORGANISMS.map((org, row) => <option key={org.name} value={row}>{org.name}</option>)}</select></label>
      <label>Column <select aria-label="Query alignment column" value={query.col} onChange={event => select({ ...query, col: Number(event.currentTarget.value) })}>{MSA[0].map((_, col) => <option key={col} value={col}>{col + START}</option>)}</select></label>
      <span className="msa-key-count">{eligibleCount} eligible keys · includes the query</span>
    </div>

    <div className="msa-viewport" ref={viewportRef} role="region" aria-label="Scrollable interactive MSA alignment" tabIndex={0}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="msa-svg" role="group" aria-label={`${mode === 'row' ? 'Row' : 'Column'} attention: ${ORGANISMS[query.row].name}, query column ${query.col + START}. Use arrow keys to move the selected query.`}>
        <defs><marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 1 L9 5 L0 9" fill="none" stroke="var(--accent)" strokeWidth="1.5" /></marker></defs>
        {mode === 'row'
          ? <rect className="msa-band" x="4" y={origin.y - 4} width={WIDTH - 14} height={CELL + 8} rx="7" />
          : <rect className="msa-band" x={origin.x - 4} y="10" width={CELL + 8} height={HEIGHT - 20} rx="7" />}
        {MSA[0].map((_, col) => <text key={col} x={xy(0, col).x + CELL / 2} y="31" textAnchor="middle" className={`msa-collabel${col === query.col ? ' msa-label-selected' : ''}`}>{col + START}</text>)}
        {ORGANISMS.map((org, row) => <g key={org.name}><text x="12" y={xy(row, 0).y + 24} className="msa-rowicon">{org.icon}</text><text x="42" y={xy(row, 0).y + 23} className={`msa-rowlabel${row === query.row ? ' msa-label-selected' : ''}`}>{org.name}</text></g>)}
        <g className="msa-connections" aria-hidden="true">
          {targets.map(target => {
            const point = xy(target.row, target.col);
            const self = target.row === query.row && target.col === query.col;
            const hovered = hover?.row === target.row && hover?.col === target.col;
            // End connections at cell edges. Their curves stay in the gutters,
            // leaving the amino-acid letters completely unobstructed.
            const d = self
              ? `M${origin.x + 11} ${origin.y + 1} C${origin.x - 2} ${origin.y - 19} ${origin.x + CELL + 2} ${origin.y - 19} ${origin.x + 25} ${origin.y + 1}`
              : mode === 'row'
                ? `M${origin.x + CELL / 2} ${origin.y + 1} Q${(origin.x + point.x + CELL) / 2} ${origin.y - Math.min(14 + Math.abs(target.col - query.col) * 3, 34)} ${point.x + CELL / 2} ${point.y + 1}`
                : `M${origin.x + CELL - 1} ${origin.y + CELL / 2} Q${origin.x + CELL + Math.min(10 + Math.abs(target.row - query.row) * 7, 36)} ${(origin.y + point.y + CELL) / 2} ${point.x + CELL - 1} ${point.y + CELL / 2}`;
            return <path key={`${target.row}-${target.col}`} d={d} className={`msa-arc${hovered ? ' msa-arc-hovered' : ''}`} markerEnd={`url(#${arrowId})`} />;
          })}
        </g>
        {MSA.map((row, r) => row.map((residue, c) => {
          const point = xy(r, c);
          const eligible = mode === 'row' ? r === query.row : c === query.col;
          const isQuery = r === query.row && c === query.col;
          return <g key={`${r}-${c}`} role="button" tabIndex={isQuery ? 0 : -1} aria-label={`${ORGANISMS[r].name}, alignment column ${c + START}, ${residue}${isQuery ? ', selected query' : eligible ? ', eligible key' : ''}`} aria-pressed={isQuery} data-row={r} data-col={c} className={`msa-cell-button${eligible ? ' msa-cell-eligible' : ''}${isQuery ? ' msa-cell-query' : ''}`} onClick={() => select({ row: r, col: c })} onKeyDown={event => keySelect(event, r, c)} onMouseEnter={() => setHover({ row: r, col: c })} onMouseLeave={() => setHover(null)} onFocus={() => setPlaying(false)}>
            <title>{`${ORGANISMS[r].name} · column ${c + START} · ${residue}. Click to set the query.`}</title>
            <rect x={point.x} y={point.y} width={CELL} height={CELL} rx="5" />
            <text x={point.x + CELL / 2} y={point.y + CELL / 2 + 5} textAnchor="middle">{residue}</text>
          </g>;
        }))}
      </svg>
    </div>
    <div className="msa-readout"><span><i className="msa-query-key" />Query</span><span><i className="msa-eligible-key" />Eligible key</span><span className="msa-hover-readout">{ORGANISMS[focus.row].name} · column {focus.col + START} · <strong>{MSA[focus.row][focus.col]}</strong></span></div>
    <figcaption className="msa-caption">
      <strong>{mode === 'row' ? 'Within one sequence.' : 'Across aligned sequences.'}</strong>{' '}
      {mode === 'row' ? 'The query can attend to every displayed position in its row, including itself.' : 'The query can attend to every displayed sequence at the same alignment column, including itself.'}{' '}
      Connections mark the positions the query can attend to; they do not show learned attention weights. This is a crop of alignment columns 6–15; scroll horizontally on a narrow screen.
      {reduced && <span className="msa-reduced"> Reduced motion is on; playback starts paused.</span>}
    </figcaption>
    <style>{`
      .msa-root{margin:1.5rem 0;padding:1rem;border:1px solid var(--rule);border-radius:.6rem;background:var(--surface-strong);font-family:var(--font-sans);color:var(--fg)}
      .msa-title{display:flex;gap:.5rem 1rem;align-items:baseline;flex-wrap:wrap;margin-bottom:.75rem}.msa-title strong{font-size:.95rem}.msa-title>span{font-size:.74rem;color:var(--fg-muted)}
      .msa-controls,.msa-querybar{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem .75rem}.msa-controls{padding-bottom:.7rem;border-bottom:1px solid var(--rule)}.msa-querybar{padding:.65rem 0}.msa-modes,.msa-playback{display:flex;gap:.25rem}.msa-modes{padding:.2rem;border:1px solid var(--rule);border-radius:.4rem;background:var(--bg)}
      .msa-root button,.msa-root select{min-height:2.25rem;border:1px solid var(--rule);border-radius:.3rem;background:var(--surface-strong);color:var(--fg);padding:.4rem .55rem;font:500 .74rem var(--font-sans);cursor:pointer}.msa-modes button{border-color:transparent;background:transparent}.msa-modes button[aria-pressed=true]{background:var(--accent);color:var(--bg)}.msa-root button:hover{border-color:var(--accent)}.msa-root :is(button,select):focus-visible,.msa-viewport:focus-visible{outline:2px solid var(--focus);outline-offset:3px}.msa-speed,.msa-querybar label{display:flex;align-items:center;gap:.4rem;font-size:.7rem;color:var(--fg-muted)}.msa-speed{margin-left:auto}.msa-key-count{margin-left:auto;font-size:.7rem;color:var(--accent)}
      .msa-viewport{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;border-block:1px solid var(--rule);border-radius:.3rem;background:var(--bg)}.msa-svg{display:block;width:100%;height:auto;min-width:720px}.msa-band{fill:color-mix(in oklab,var(--accent) 7%,transparent);stroke:color-mix(in oklab,var(--accent) 18%,transparent);stroke-width:1}.msa-collabel{fill:var(--fg-muted);font:11px var(--font-mono)}.msa-rowlabel{fill:var(--fg-muted);font:italic 11.5px var(--font-sans)}.msa-rowicon{font-size:19px}.msa-label-selected{fill:var(--accent);font-weight:700}.msa-arc{fill:none;stroke:var(--accent);stroke-width:1.4;opacity:.65;pointer-events:none}.msa-arc-hovered{stroke-width:2.4;opacity:1}.msa-playing .msa-arc{stroke-dasharray:4 3;animation:msa-travel 1.2s linear infinite}.msa-connections{pointer-events:none}
      .msa-cell-button{cursor:pointer;outline:none}.msa-cell-button rect{fill:var(--surface-strong);stroke:var(--rule-strong);stroke-width:.8;transition:fill 180ms,stroke 180ms}.msa-cell-button text{fill:var(--fg-muted);font:14px var(--font-mono);pointer-events:none;user-select:none}.msa-cell-eligible rect{fill:color-mix(in oklab,var(--accent) 15%,var(--surface-strong));stroke:var(--accent)}.msa-cell-eligible text{fill:var(--fg)}.msa-cell-query rect{fill:var(--accent);stroke:var(--accent);stroke-width:2}.msa-cell-query text{fill:var(--bg);font-weight:700}.msa-cell-button:hover rect{stroke:var(--accent);stroke-width:2.5}.msa-cell-button:focus-visible rect{stroke:var(--focus);stroke-width:3;stroke-dasharray:3 2}.msa-cell-button:focus-visible text{font-weight:700}
      .msa-readout{display:flex;align-items:center;flex-wrap:wrap;gap:.45rem 1rem;margin-top:.65rem;font-size:.7rem;color:var(--fg-muted)}.msa-readout>span{display:inline-flex;align-items:center;gap:.35rem}.msa-readout i{display:inline-block;width:.65rem;height:.65rem;border:1px solid var(--accent);border-radius:2px}.msa-query-key{background:var(--accent)}.msa-eligible-key{background:color-mix(in oklab,var(--accent) 15%,var(--surface-strong))}.msa-hover-readout{margin-left:auto}.msa-caption{margin:.65rem 0 0!important;color:var(--fg-muted);font-size:.75rem;line-height:1.65}.msa-caption strong{color:var(--fg)}.msa-reduced{font-style:italic}
      @keyframes msa-travel{to{stroke-dashoffset:-14}}@media(prefers-reduced-motion:reduce){.msa-playing .msa-arc{animation:none;stroke-dasharray:none}.msa-cell-button rect{transition:none}}@media(max-width:600px){.msa-root{padding:.8rem}.msa-speed{margin-left:0}.msa-key-count,.msa-hover-readout{margin-left:0}.msa-querybar label:first-child{flex:1}.msa-querybar label:first-child select{min-width:0;max-width:100%}.msa-querybar select{font-size:.7rem}.msa-title>span{font-size:.72rem}}
    `}</style>
  </figure>;
}
