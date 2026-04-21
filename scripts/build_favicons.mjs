#!/usr/bin/env node
// Renders the SVG favicon to PNG sizes used by older browsers and iOS.
// Run once after editing public/favicon.svg:
//     node scripts/build_favicons.mjs
//
// The SVG itself serves as the primary favicon for modern browsers via
// <link rel="icon" type="image/svg+xml" href="/favicon.svg">.
// The rendered PNGs are only for legacy / platform-specific fallbacks.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const PUBLIC = resolve(process.cwd(), 'public');
const svg = readFileSync(resolve(PUBLIC, 'favicon.svg'), 'utf8');

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

// Ship a .ico alongside — many browsers still request /favicon.ico directly.
// A PNG renamed to .ico is accepted by every modern browser (not spec-correct,
// but battle-tested). For strict ICO compliance you'd need png-to-ico; this is
// good enough for the cosmetic purpose of not 404ing.
const favicon32 = new Resvg(svg, { fitTo: { mode: 'width', value: 32 } }).render().asPng();
writeFileSync(resolve(PUBLIC, 'favicon.ico'), favicon32);
console.log('wrote public/favicon.ico (32x32 PNG-as-ICO)');
