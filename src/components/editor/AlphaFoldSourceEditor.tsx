import katex from 'katex';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

type EditorStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'error';

interface LoadResponse {
  markdown: string;
  path: string;
}

interface MdxParts {
  preamble: string;
  body: string;
}

const EDITOR_API = '/api/editor/alphafold2';
const PREVIEW_PATH = '/alphafold2/';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderLatex(latex: string, displayMode: boolean) {
  return katex.renderToString(latex.trim(), {
    displayMode,
    output: 'htmlAndMathml',
    strict: 'ignore',
    throwOnError: false,
    trust: false,
  });
}

function stripMathFence(source: string) {
  const trimmed = source.trim();
  if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

function countWords(markdown: string) {
  const words = markdown.trim().match(/\S+/g);
  return words?.length ?? 0;
}

function splitMdxSource(markdown: string): MdxParts {
  let preamble = '';
  let body = markdown;

  const frontmatter = body.match(/^---\n[\s\S]*?\n---\n*/);
  if (frontmatter) {
    preamble += frontmatter[0];
    body = body.slice(frontmatter[0].length);
  }

  const lines = body.split('\n');
  let bodyStart = 0;
  for (; bodyStart < lines.length; bodyStart += 1) {
    const trimmed = lines[bodyStart].trim();
    if (trimmed === '' || trimmed.startsWith('import ')) continue;
    break;
  }

  if (bodyStart > 0) {
    preamble += lines.slice(0, bodyStart).join('\n');
    body = lines.slice(bodyStart).join('\n');
  }

  return { preamble, body };
}

function joinMdxSource(preamble: string, body: string) {
  if (!preamble) return body;
  return `${preamble.trimEnd()}\n\n${body.trimStart()}`;
}

function stripFrontmatterAndImports(markdown: string) {
  let body = markdown.replace(/^---[\s\S]*?\n---\n+/, '');
  body = body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import '))
    .join('\n');
  return body.trimStart();
}

function getAttribute(source: string, name: string) {
  const pattern = new RegExp(`${name}=("([^"]*)"|'([^']*)'|\\{([^}]*)\\})`);
  const match = source.match(pattern);
  return match?.[2] ?? match?.[3] ?? match?.[4]?.replace(/^['"]|['"]$/g, '') ?? '';
}

function replaceInlineMath(source: string, render: (latex: string) => string) {
  let output = '';
  let index = 0;

  while (index < source.length) {
    if (source[index] === '\\' && source[index + 1] === '$') {
      output += '$';
      index += 2;
      continue;
    }

    if (source[index] !== '$' || source[index + 1] === '$') {
      output += source[index];
      index += 1;
      continue;
    }

    let end = index + 1;
    let closing = -1;
    while (end < source.length) {
      const next = source.indexOf('$', end);
      if (next === -1) break;
      if (source[next - 1] !== '\\') {
        closing = next;
        break;
      }
      end = next + 1;
    }

    const latex = closing === -1 ? '' : source.slice(index + 1, closing);
    if (!latex || latex.includes('\n')) {
      output += source[index];
      index += 1;
      continue;
    }

    output += render(latex);
    index = closing + 1;
  }

  return output;
}

function inlineMarkdown(value: string) {
  const html: string[] = [];
  const stashHtml = (fragment: string) => {
    html.push(fragment);
    return `@@HTML_${html.length - 1}@@`;
  };

  const withCode = value.replace(/`([^`]+)`/g, (_match, code) => stashHtml(`<code>${escapeHtml(code)}</code>`));
  const withMath = replaceInlineMath(withCode, (latex) => stashHtml(renderLatex(latex, false)));

  return escapeHtml(withMath)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/@@HTML_(\d+)@@/g, (_match, key) => html[Number(key)] ?? '');
}

function renderMarkdownBlocks(source: string): string {
  const lines = source.split('\n');
  const html: string[] = [];
  let index = 0;

  const readParagraph = () => {
    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();
      if (
        trimmed === '' ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('>') ||
        trimmed.startsWith('```') ||
        trimmed.startsWith('$$') ||
        trimmed.startsWith('<') ||
        /^[-*]\s+/.test(trimmed) ||
        /^\d+\.\s+/.test(trimmed)
      ) {
        break;
      }
      paragraphLines.push(trimmed);
      index += 1;
    }
    html.push(`<p>${inlineMarkdown(paragraphLines.join(' '))}</p>`);
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '') {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(`<pre><code data-language="${escapeHtml(language)}">${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    if (trimmed.startsWith('$$')) {
      const mathLines: string[] = [];
      const singleLine = trimmed.match(/^\$\$(.*)\$\$$/);
      if (singleLine && singleLine[1].trim()) {
        mathLines.push(singleLine[1]);
        index += 1;
      } else {
        mathLines.push(trimmed.replace(/^\$\$/, ''));
        index += 1;
        while (index < lines.length && !lines[index].trim().endsWith('$$')) {
          mathLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          mathLines.push(lines[index].replace(/\$\$\s*$/, ''));
          index += 1;
        }
      }
      html.push(renderLatex(mathLines.join('\n'), true));
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote><p>${inlineMarkdown(quoteLines.join(' '))}</p></blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(`<li>${inlineMarkdown(lines[index].trim().replace(/^[-*]\s+/, ''))}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(`<li>${inlineMarkdown(lines[index].trim().replace(/^\d+\.\s+/, ''))}</li>`);
        index += 1;
      }
      html.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    if (trimmed.startsWith('<')) {
      const blockLines: string[] = [];
      while (index < lines.length && lines[index].trim() !== '') {
        blockLines.push(lines[index]);
        index += 1;
      }
      html.push(blockLines.join('\n'));
      continue;
    }

    readParagraph();
  }

  return html.join('\n');
}

function renderMdxComponents(source: string) {
  let body = source;

  body = body.replace(/<EditorialNote>([\s\S]*?)<\/EditorialNote>/g, (_match, content) => {
    return `<blockquote class="editorial-note">${renderMarkdownBlocks(content.trim())}</blockquote>`;
  });

  body = body.replace(/<Sidenote>([\s\S]*?)<\/Sidenote>/g, (_match, content) => {
    return `<aside class="sidenote">${renderMarkdownBlocks(content.trim())}</aside>`;
  });

  body = body.replace(/<PaperQuote([^>]*)>([\s\S]*?)<\/PaperQuote>/g, (_match, attrs, content) => {
    const sourceLabel = getAttribute(attrs, 'source');
    const cite = sourceLabel ? `<cite>${escapeHtml(sourceLabel)}</cite>` : '';
    return `<blockquote class="paper-quote">${renderMarkdownBlocks(content.trim())}${cite}</blockquote>`;
  });

  body = body.replace(/<Callout([^>]*)>([\s\S]*?)<\/Callout>/g, (_match, attrs, content) => {
    const title = getAttribute(attrs, 'title');
    const variant = getAttribute(attrs, 'variant') || 'note';
    const heading = title ? `<p class="callout-title"><strong>${escapeHtml(title)}</strong></p>` : '';
    return `<div class="callout" data-variant="${escapeHtml(variant)}">${heading}${renderMarkdownBlocks(content.trim())}</div>`;
  });

  body = body.replace(/<AlgorithmBox([^>]*)>([\s\S]*?)<\/AlgorithmBox>/g, (_match, attrs, content) => {
    const number = getAttribute(attrs, 'number');
    const name = getAttribute(attrs, 'name');
    const heading = number || name ? `<header>Algorithm ${escapeHtml(number)}${name ? ` - ${escapeHtml(name)}` : ''}</header>` : '';
    return `<figure class="algorithm-box">${heading}${renderMarkdownBlocks(content.trim())}</figure>`;
  });

  body = body.replace(/<Figure([^>]*)>([\s\S]*?)<\/Figure>/g, (_match, attrs, content) => {
    const caption = getAttribute(attrs, 'caption');
    return `<figure>${content.trim()}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
  });

  body = body.replace(/<Snippet([^/]*)\/>/g, (_match, attrs) => {
    const file = getAttribute(attrs, 'file');
    const symbol = getAttribute(attrs, 'symbol');
    const lines = getAttribute(attrs, 'lines');
    const title = getAttribute(attrs, 'title');
    const label = title || [file, symbol || lines].filter(Boolean).join(' ');
    return `<figure class="snippet live-preview-placeholder"><pre><code>${escapeHtml(label || 'Snippet')}</code></pre><footer>Snippet renders exactly after Save</footer></figure>`;
  });

  body = body.replace(/<CodeRef([^/]*)\/>/g, (_match, attrs) => {
    const file = getAttribute(attrs, 'file');
    const symbol = getAttribute(attrs, 'symbol');
    return `<code>${escapeHtml(symbol || file || 'CodeRef')}</code>`;
  });

  body = body.replace(/<Equation([^>]*)>([\s\S]*?)<\/Equation>/g, (_match, attrs, content) => {
    const id = getAttribute(attrs, 'id');
    const number = getAttribute(attrs, 'number');
    const idAttribute = id ? ` id="${escapeHtml(id)}"` : '';
    const numberHtml = number ? `<div class="equation-number">(${escapeHtml(number)})</div>` : '';
    return `<div class="equation"${idAttribute}><div class="equation-body">${renderLatex(stripMathFence(content), true)}</div>${numberHtml}</div>`;
  });

  body = body.replace(/<Equation([^/]*)\/>/g, (_match, attrs) => {
    const label = getAttribute(attrs, 'label') || 'Equation';
    return `<div class="live-preview-placeholder">${escapeHtml(label)}</div>`;
  });

  body = body.replace(/<([A-Z][A-Za-z0-9]*)([^>]*)\/>/g, (_match, name) => {
    return `<figure class="live-preview-placeholder"><strong>${escapeHtml(name)}</strong><span>Interactive component renders exactly after Save</span></figure>`;
  });

  return body;
}

function renderLivePreview(markdown: string) {
  const body = renderMdxComponents(stripFrontmatterAndImports(markdown));
  return renderMarkdownBlocks(body);
}

function lineAndColumn(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return { line: 1, column: 1 };

  const beforeCursor = textarea.value.slice(0, textarea.selectionStart);
  const lines = beforeCursor.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

export default function AlphaFoldSourceEditor() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const isSyncingScrollRef = useRef(false);
  const [sourcePreamble, setSourcePreamble] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [savedMarkdown, setSavedMarkdown] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [status, setStatus] = useState<EditorStatus>('loading');
  const [message, setMessage] = useState('Loading AlphaFold2 MDX source...');
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const deferredMarkdown = useDeferredValue(markdown);

  const dirty = markdown !== savedMarkdown;
  const livePreviewHtml = useMemo(() => renderLivePreview(deferredMarkdown), [deferredMarkdown]);
  const stats = useMemo(
    () => ({
      lines: markdown ? markdown.split('\n').length : 0,
      words: countWords(markdown),
    }),
    [markdown],
  );

  function syncScroll(source: HTMLElement, target: HTMLElement | null) {
    if (!target || isSyncingScrollRef.current) return;

    const sourceMax = source.scrollHeight - source.clientHeight;
    const targetMax = target.scrollHeight - target.clientHeight;
    const ratio = sourceMax > 0 ? source.scrollTop / sourceMax : 0;

    isSyncingScrollRef.current = true;
    target.scrollTop = ratio * Math.max(targetMax, 0);
    window.requestAnimationFrame(() => {
      isSyncingScrollRef.current = false;
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function loadSource() {
      try {
        setStatus('loading');
        const response = await fetch(EDITOR_API, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Could not load source (${response.status}).`);

        const payload = (await response.json()) as LoadResponse;
        if (cancelled) return;

        const parts = splitMdxSource(payload.markdown);
        setSourcePreamble(parts.preamble);
        setMarkdown(parts.body);
        setSavedMarkdown(parts.body);
        setSourcePath(payload.path);
        setStatus('idle');
        setMessage('Loaded article body from disk.');
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Could not load source.');
      }
    }

    loadSource();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  async function reloadFromDisk() {
    if (dirty && !window.confirm('Discard unsaved editor changes and reload from disk?')) return;

    try {
      setStatus('loading');
      setMessage('Reloading from disk...');
      const response = await fetch(EDITOR_API, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not reload source (${response.status}).`);

      const payload = (await response.json()) as LoadResponse;
      const parts = splitMdxSource(payload.markdown);
      setSourcePreamble(parts.preamble);
      setMarkdown(parts.body);
      setSavedMarkdown(parts.body);
      setSourcePath(payload.path);
      setStatus('idle');
      setMessage('Reloaded article body from disk.');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not reload source.');
    }
  }

  async function saveToDisk() {
    try {
      setStatus('saving');
      setMessage('Saving MDX source...');
      const response = await fetch(EDITOR_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: joinMdxSource(sourcePreamble, markdown) }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Could not save source (${response.status}).`);
      }

      setSavedMarkdown(markdown);
      setStatus('saved');
      setMessage('Saved to disk.');

      window.setTimeout(() => {
        setStatus('idle');
      }, 450);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not save source.');
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (dirty && status !== 'saving') void saveToDisk();
      return;
    }

    if (event.key !== 'Tab') return;

    event.preventDefault();
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = `${markdown.slice(0, start)}  ${markdown.slice(end)}`;
    setMarkdown(next);

    window.requestAnimationFrame(() => {
      textarea.selectionStart = start + 2;
      textarea.selectionEnd = start + 2;
      setCursor(lineAndColumn(textarea));
    });
  }

  const canSave = dirty && status !== 'saving' && status !== 'loading';

  return (
    <section className="source-editor">
      <header className="source-editor-header">
        <div>
          <p className="source-editor-kicker">Local MDX editor</p>
          <h1>Edit AlphaFold2</h1>
          <p className="source-editor-path">{sourcePath || 'src/content/papers/alphafold2/index.mdx'}</p>
        </div>

        <div className="source-editor-actions" aria-label="Editor actions">
          <a href={PREVIEW_PATH} target="_blank" rel="noreferrer">
            Open page
          </a>
          <button type="button" onClick={reloadFromDisk} disabled={status === 'loading' || status === 'saving'}>
            Reload
          </button>
          <button type="button" className="source-editor-save" onClick={saveToDisk} disabled={!canSave}>
            {status === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </header>

      <div className="source-editor-status" data-state={status} role={status === 'error' ? 'alert' : 'status'}>
        <span>{dirty ? 'Unsaved changes' : 'No unsaved changes'}</span>
        <span>{message}</span>
      </div>

      <div className="source-editor-workspace">
        <section className="source-editor-pane source-editor-pane--source" aria-label="MDX source editor">
          <div className="source-editor-pane-head">
            <span>Source</span>
            <span>
              Ln {cursor.line}, Col {cursor.column} · {stats.lines} lines · {stats.words} words
            </span>
          </div>
          <textarea
            ref={textareaRef}
            value={markdown}
            spellCheck={false}
            onChange={(event) => {
              setMarkdown(event.target.value);
              setCursor(lineAndColumn(event.target));
              if (status === 'saved') setStatus('idle');
            }}
            onClick={(event) => setCursor(lineAndColumn(event.currentTarget))}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => setCursor(lineAndColumn(event.currentTarget))}
            onScroll={(event) => syncScroll(event.currentTarget, previewRef.current)}
            aria-label="AlphaFold2 MDX source"
          />
        </section>

        <section className="source-editor-pane source-editor-pane--preview" aria-label="Rendered preview">
          <div className="source-editor-pane-head">
            <span>Live preview</span>
            <span>synced unsaved draft</span>
          </div>
          <article
            ref={previewRef}
            className="source-editor-live-preview prose"
            onScroll={(event) => syncScroll(event.currentTarget, textareaRef.current)}
            dangerouslySetInnerHTML={{ __html: livePreviewHtml }}
          />
        </section>
      </div>
    </section>
  );
}
