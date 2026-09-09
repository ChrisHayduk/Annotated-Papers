#!/usr/bin/env node
// Regenerates the brand icons and homepage social card.
// Run after editing public/brand-mark.svg or the card layout below:
//     node scripts/build_favicons.mjs
//
// The SVG itself serves as the primary favicon for modern browsers via
// <link rel="icon" type="image/svg+xml" href="/favicon.svg">.
// The rendered PNGs are only for legacy / platform-specific fallbacks.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { html } from 'satori-html';

const PUBLIC = resolve(process.cwd(), 'public');
const brandMark = readFileSync(resolve(PUBLIC, 'brand-mark.svg'), 'utf8');
if (!/<svg\b[^>]*\bviewBox=["']0 0 64 64["']/.test(brandMark)) {
  throw new Error('public/brand-mark.svg must have viewBox="0 0 64 64".');
}
// Keep the transparent mark as the source for both social cards and icons.
// Adding the background inside its root preserves its geometry and definitions.
const svg = brandMark.replace(
  /(<svg\b[^>]*>)/,
  '$1\n  <rect width="64" height="64" rx="12" fill="#f7f8f3"/>',
);
writeFileSync(resolve(PUBLIC, 'favicon.svg'), svg);
console.log('wrote public/favicon.svg (64x64)');

const sizes = [
  { name: 'favicon-32.png', width: 32 },
  { name: 'favicon-180.png', width: 180 },        // alternate
  { name: 'apple-touch-icon.png', width: 180 },   // iOS home-screen icon
];

for (const { name, width } of sizes) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  writeFileSync(resolve(PUBLIC, name), png);
  console.log(`wrote public/${name} (${width}x${width})`);
}

// Wrap the PNG payload in a proper ICO directory so browsers requesting the
// legacy path receive the format its extension promises.
const favicon32 = new Resvg(svg, { fitTo: { mode: 'width', value: 32 } }).render().asPng();
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2); // Icon resource.
icoHeader.writeUInt16LE(1, 4); // One image.
icoHeader[6] = 32;
icoHeader[7] = 32;
icoHeader.writeUInt16LE(1, 10); // Color planes.
icoHeader.writeUInt16LE(32, 12); // Bits per pixel.
icoHeader.writeUInt32LE(favicon32.length, 14);
icoHeader.writeUInt32LE(22, 18); // Image offset.
writeFileSync(resolve(PUBLIC, 'favicon.ico'), Buffer.concat([icoHeader, favicon32]));
console.log('wrote public/favicon.ico (32x32)');

const fontRoot = resolve(process.cwd(), 'node_modules/@fontsource/inter/files');
const brandIcon = `data:image/svg+xml;base64,${Buffer.from(brandMark).toString('base64')}`;
const card = html`
  <div style="width: 1200px; height: 630px; padding: 58px 68px; display: flex; flex-direction: column; position: relative; background: #f7f8f3; color: #152d28; font-family: Inter;">
    <div style="display: flex; align-items: center; gap: 17px;">
      <img src="${brandIcon}" style="width: 64px; height: 64px;" />
      <div style="display: flex; flex-direction: column; gap: 5px;">
        <div style="font-size: 26px; font-weight: 700; letter-spacing: -0.6px;">Annotated Papers</div>
        <div style="font-size: 20px; color: #5c6f65;">by Chris Hayduk</div>
      </div>
    </div>
    <div style="display: flex; flex-direction: column; margin-top: 57px; font-size: 70px; line-height: 1.08; font-weight: 700; letter-spacing: -3px;">
      <div>Biological AI</div>
      <div style="color: #1e6750;">papers, annotated.</div>
    </div>
    <div style="display: flex; max-width: 850px; margin-top: 25px; font-size: 25px; line-height: 1.5; color: #5c6f65;">Notes on research papers, with PyTorch implementations and interactive figures.</div>
    <div style="display: flex; align-items: center; margin-top: auto; padding-top: 23px; border-top: 1px solid #dbe3d6;">
      <div style="font-size: 18px; color: #1e6750;">annotated.chrishayduk.com</div>
    </div>
    <div style="position: absolute; bottom: 0; left: 0; width: 1200px; height: 8px; display: flex; background: #1e6750;">
      <div style="display: flex; margin-left: auto; width: 240px; height: 8px; background: #a6c966;"></div>
    </div>
  </div>
`;
const cardSvg = await satori(card, {
  width: 1200,
  height: 630,
  fonts: [400, 700].map((weight) => ({
    name: 'Inter',
    data: readFileSync(resolve(fontRoot, `inter-latin-${weight}-normal.woff`)),
    weight,
    style: 'normal',
  })),
});
writeFileSync(resolve(PUBLIC, 'og.png'), new Resvg(cardSvg).render().asPng());
console.log('wrote public/og.png (1200x630)');
