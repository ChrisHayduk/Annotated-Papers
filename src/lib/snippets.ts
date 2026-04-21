import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const VENDOR_ROOT = resolve(process.cwd(), 'vendor/min-AlphaFold');
const REPO_URL = 'https://github.com/ChrisHayduk/minAlphaFold2';
const DEFAULT_COMMIT = process.env.MIN_ALPHAFOLD_COMMIT ?? '1aa629bef31300b0f9bc32235bfe8f95a8ff09e6';

export interface ExtractOptions {
  start?: number;
  end?: number;
  symbol?: string;
}

export interface ExtractResult {
  code: string;
  start: number;
  end: number;
  file: string;
}

function dedent(lines: string[]): string[] {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return lines;
  const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0));
  return lines.map((l) => l.slice(minIndent));
}

function findSymbolRange(lines: string[], symbol: string): [number, number] | null {
  const declRe = new RegExp(`^(\\s*)(def|class|async def)\\s+${symbol}\\b`);
  let startIdx = -1;
  let indentWidth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(declRe);
    if (m) {
      startIdx = i;
      indentWidth = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;
  let endIdx = lines.length - 1;
  for (let j = startIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim().length === 0) continue;
    const m = line.match(/^(\s*)/);
    const lead = m?.[1].length ?? 0;
    if (lead <= indentWidth) {
      endIdx = j - 1;
      break;
    }
  }
  return [startIdx + 1, endIdx + 1];
}

export function extractSnippet(file: string, opts: ExtractOptions = {}): ExtractResult {
  const absolute = resolve(VENDOR_ROOT, file);
  if (!existsSync(absolute)) {
    throw new Error(
      `Snippet source not found: ${absolute}. Did you run \`git submodule update --init\` to fetch vendor/min-AlphaFold?`,
    );
  }
  const source = readFileSync(absolute, 'utf8');
  const allLines = source.split('\n');

  let startLine = opts.start;
  let endLine = opts.end;

  if (opts.symbol) {
    const range = findSymbolRange(allLines, opts.symbol);
    if (!range) throw new Error(`Symbol ${opts.symbol} not found in ${file}`);
    [startLine, endLine] = range;
  }

  if (!startLine || !endLine) {
    throw new Error(`Snippet ${file} requires start/end or a symbol`);
  }
  if (startLine < 1 || endLine > allLines.length || startLine > endLine) {
    throw new Error(`Invalid snippet range ${startLine}-${endLine} in ${file} (total ${allLines.length} lines)`);
  }

  const slice = allLines.slice(startLine - 1, endLine);
  const code = dedent(slice).join('\n').replace(/\s+$/, '');
  return { code, start: startLine, end: endLine, file };
}

export function resolveRepoUrl(file: string, lines?: string): string {
  const base = `${REPO_URL}/blob/${DEFAULT_COMMIT}/${file}`;
  if (!lines) return base;
  const m = lines.match(/^(\d+)-(\d+)$/);
  return m ? `${base}#L${m[1]}-L${m[2]}` : base;
}
