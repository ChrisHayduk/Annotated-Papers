import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { createElement, type CSSProperties, type ReactNode } from 'react';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Satori supports the WOFF files bundled with Inter, so rendering stays local.
const FONT_ROOT = resolve(process.cwd(), 'node_modules/@fontsource/inter/files');
const interRegular = readFileSync(resolve(FONT_ROOT, 'inter-latin-400-normal.woff'));
const interBold = readFileSync(resolve(FONT_ROOT, 'inter-latin-700-normal.woff'));
const brandIcon = `data:image/svg+xml;base64,${readFileSync(resolve(process.cwd(), 'public/brand-mark.svg')).toString('base64')}`;
const box = (style: CSSProperties, ...children: ReactNode[]) => createElement('div', { style: { display: 'flex', ...style } }, ...children);

export async function getStaticPaths() {
  const papers = await getCollection('papers', (entry) => !entry.data.draft);
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
  const titleSize = title.length > 75 ? 48 : title.length > 50 ? 58 : 68;

  // Pass metadata as text nodes so titles and subtitles never become markup.
  const markup = box({
    width: 1200, height: 630, padding: '58px 68px', flexDirection: 'column',
    position: 'relative', background: '#f7f8f3', color: '#152d28', fontFamily: 'Inter',
  },
    box({ alignItems: 'center', gap: 17 },
      createElement('img', { src: brandIcon, width: 64, height: 64 }),
      box({ flexDirection: 'column', gap: 5 },
        box({ fontSize: 26, fontWeight: 700, letterSpacing: -0.6 }, 'Annotated Papers'),
        box({ fontSize: 20, color: '#5c6f65' }, 'by Chris Hayduk'),
      ),
    ),
    box({ flex: 1, flexDirection: 'column', justifyContent: 'center' },
      box({ fontSize: 15, fontWeight: 700, letterSpacing: 1.8, color: '#1e6750', marginBottom: 20 }, 'PAPER WALKTHROUGH'),
      box({ maxWidth: 1050, fontSize: titleSize, lineHeight: 1.1, fontWeight: 700, letterSpacing: -2.6 }, title),
      subtitle ? box({ maxWidth: 960, fontSize: 27, lineHeight: 1.45, color: '#5c6f65', marginTop: 22 }, subtitle) : null,
    ),
    box({ alignItems: 'flex-end', justifyContent: 'space-between', borderTop: '1px solid #dbe3d6', paddingTop: 23 },
      box({ flexDirection: 'column', gap: 8, maxWidth: 720 },
        box({ fontSize: 21 }, metaLine),
        box({ fontSize: 17, color: '#5c6f65' }, `Annotated by ${annotator}`),
      ),
      box({ fontSize: 18, color: '#1e6750' }, 'annotated.chrishayduk.com'),
    ),
    box({ position: 'absolute', bottom: 0, left: 0, width: 1200, height: 8, background: '#1e6750' },
      box({ marginLeft: 'auto', width: 240, height: 8, background: '#a6c966' }),
    ),
  );

  const svg = await satori(markup, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
      { name: 'Inter', data: interBold, weight: 700, style: 'normal' },
    ],
  });
  const png = new Resvg(svg).render().asPng();

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
