import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import satori from 'satori';
import { html } from 'satori-html';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolve font files synchronously from @fontsource/inter. satori accepts WOFF
// (but not WOFF2), and @fontsource ships WOFF under /files.
const FONT_ROOT = resolve(process.cwd(), 'node_modules/@fontsource/inter/files');
const interRegular = readFileSync(resolve(FONT_ROOT, 'inter-latin-400-normal.woff'));
const interMedium = readFileSync(resolve(FONT_ROOT, 'inter-latin-500-normal.woff'));
const interBold = readFileSync(resolve(FONT_ROOT, 'inter-latin-700-normal.woff'));

// Per-paper decorative background. Keyed by slug; falls back to an empty
// element if we haven't custom-designed one. Rendered absolutely positioned
// at the top-right of the card.
function decorationFor(slug: string): string {
  if (slug === 'alphafold2') {
    // A 5×3 grid of triangles, loosely evoking the AF2 pair-rep triangle
    // multiplication motif. Drawn with inline SVG; muted against the dark bg.
    const rows = 3;
    const cols = 5;
    const size = 56;
    const gap = 18;
    const triangles: string[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * (size + gap);
        const y = r * (size + gap);
        const opacity = 0.08 + 0.14 * ((r + c) % 3) / 2;
        triangles.push(
          `<polygon points="${x + size / 2},${y} ${x + size},${y + size} ${x},${y + size}" fill="rgba(232,161,161,${opacity.toFixed(2)})" />`,
        );
      }
    }
    const svgW = cols * (size + gap);
    const svgH = rows * (size + gap);
    return `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">${triangles.join('')}</svg>`;
  }
  return '';
}

export async function getStaticPaths() {
  const papers = await getCollection('papers', (e) => !e.data.draft);
  return papers.map((entry) => ({
    params: { paper: entry.data.slug },
    props: { entry },
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const entry = (props as { entry: Awaited<ReturnType<typeof getCollection>>[number] }).entry;
  const { title, subtitle, authors, paperYear, annotator, venue } = entry.data;

  const authorsShort = authors.length <= 3 ? authors.join(', ') : `${authors[0]} et al.`;
  const metaLine = [authorsShort, String(paperYear), venue].filter(Boolean).join(' · ');
  const decoration = decorationFor(entry.data.slug);

  const markup = html`
    <div style="
      width: 1200px;
      height: 630px;
      background: #14161a;
      color: #e9ebee;
      font-family: 'Inter';
      display: flex;
      flex-direction: column;
      padding: 64px 72px;
      position: relative;
    ">
      <div style="
        position: absolute;
        top: 40px;
        right: 72px;
        opacity: 0.9;
        display: flex;
      ">${decoration}</div>

      <div style="
        display: flex;
        font-size: 18px;
        letter-spacing: 2.4px;
        text-transform: uppercase;
        color: #a8adb5;
        font-weight: 500;
      ">
        Annotated Papers by Chris Hayduk
      </div>

      <div style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
        <div style="
          display: flex;
          font-size: 68px;
          line-height: 1.08;
          font-weight: 700;
          letter-spacing: -0.015em;
          color: #e9ebee;
          max-width: 1000px;
          margin: 0;
        ">${title}</div>
        ${subtitle
          ? `<div style="display: flex; font-size: 28px; line-height: 1.35; color: #a8adb5; font-weight: 400; margin-top: 20px; max-width: 900px;">${subtitle}</div>`
          : ''}
      </div>

      <div style="
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        font-size: 22px;
        color: #a8adb5;
      ">
        <div style="display: flex; flex-direction: column;">
          <div style="display: flex; color: #c9ccd2;">${metaLine}</div>
          <div style="display: flex; margin-top: 6px; font-size: 19px;">Annotated by ${annotator}</div>
        </div>
        <div style="display: flex; font-size: 20px; color: #e8a1a1; font-weight: 500;">
          annotated.chrishayduk.com
        </div>
      </div>
    </div>
  `;

  const svg = await satori(markup as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
      { name: 'Inter', data: interMedium, weight: 500, style: 'normal' },
      { name: 'Inter', data: interBold, weight: 700, style: 'normal' },
    ],
  });

  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();

  // Wrap the Node Buffer in a Uint8Array so it satisfies Response's BodyInit
  // type. TypeScript 5+/6 tightened up Buffer<ArrayBufferLike> so it no longer
  // auto-assigns to BodyInit. The underlying bytes are the same.
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
