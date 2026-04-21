#!/usr/bin/env node
// Walks every MDX file under src/content/papers/** and verifies that each
// <Snippet ... /> and <CodeRef ... /> references a file (and line range or
// symbol) that actually exists in vendor/min-AlphaFold.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const CONTENT_ROOT = resolve(ROOT, 'src/content/papers');
const VENDOR_ROOT = resolve(ROOT, 'vendor/min-AlphaFold');

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.mdx')) out.push(p);
  }
  return out;
}

function extractAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4];
  }
  return attrs;
}

function findSymbolInSource(src, symbol) {
  const re = new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${symbol}\\b`, 'm');
  return re.test(src);
}

let errors = 0;
let checked = 0;

for (const mdx of walk(CONTENT_ROOT)) {
  const src = readFileSync(mdx, 'utf8');
  // Match both self-closing <Tag ... /> and paired <Tag ...></Tag>, letting
  // attribute values contain '/' (e.g. file="minalphafold/evoformer.py").
  const matches = [...src.matchAll(/<(Snippet|CodeRef)(\s+[\s\S]*?)\/?>/g)];
  for (const [, tag, attrBlob] of matches) {
    checked++;
    const attrs = extractAttrs(attrBlob);
    if (!attrs.file) {
      console.error(`✗ ${mdx}: <${tag}> is missing \`file\` attribute`);
      errors++;
      continue;
    }
    const absolute = resolve(VENDOR_ROOT, attrs.file);
    if (!existsSync(absolute)) {
      console.error(`✗ ${mdx}: <${tag} file="${attrs.file}"> — file not found under vendor/min-AlphaFold`);
      errors++;
      continue;
    }
    const source = readFileSync(absolute, 'utf8');
    const totalLines = source.split('\n').length;

    if (attrs.lines) {
      const m = attrs.lines.match(/^(\d+)-(\d+)$/);
      if (!m) {
        console.error(`✗ ${mdx}: <${tag} file="${attrs.file}" lines="${attrs.lines}"> — lines must be "N-M"`);
        errors++;
        continue;
      }
      const [s, e] = [Number(m[1]), Number(m[2])];
      if (s < 1 || e > totalLines || s > e) {
        console.error(`✗ ${mdx}: <${tag} file="${attrs.file}" lines="${attrs.lines}"> — range out of bounds (file has ${totalLines} lines)`);
        errors++;
        continue;
      }
    } else if (attrs.start && attrs.end) {
      const [s, e] = [Number(attrs.start), Number(attrs.end)];
      if (s < 1 || e > totalLines || s > e) {
        console.error(`✗ ${mdx}: <${tag} file="${attrs.file}" start=${attrs.start} end=${attrs.end}> — range out of bounds`);
        errors++;
        continue;
      }
    } else if (attrs.symbol) {
      if (!findSymbolInSource(source, attrs.symbol)) {
        console.error(`✗ ${mdx}: <${tag} file="${attrs.file}" symbol="${attrs.symbol}"> — symbol not found`);
        errors++;
        continue;
      }
    } else if (tag === 'Snippet') {
      console.error(`✗ ${mdx}: <Snippet file="${attrs.file}"> requires lines="N-M", start+end, or symbol`);
      errors++;
      continue;
    }
  }
}

if (!existsSync(VENDOR_ROOT)) {
  console.warn(`⚠ vendor/min-AlphaFold not present — snippet verifier skipped all Snippet/CodeRef checks that touch source files.`);
  console.warn(`  Run \`git submodule update --init\` once the submodule is added.`);
}

console.log(`verify-snippets: checked ${checked} reference(s), ${errors} error(s)`);
process.exit(errors > 0 ? 1 : 0);
