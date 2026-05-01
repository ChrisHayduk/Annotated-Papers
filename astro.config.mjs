// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';

const ALPHAFOLD2_MDX_PATH = resolve(process.cwd(), 'src/content/papers/alphafold2/index.mdx');

/** @returns {any} */
function alphaFoldEditorDevApi() {
  return {
    name: 'alphafold-editor-dev-api',
    /** @param {{ middlewares: { use: Function } }} server */
    configureServer(server) {
      /**
       * @param {import('node:http').IncomingMessage} req
       * @param {import('node:http').ServerResponse} res
       * @param {(err?: unknown) => void} next
       */
      const handleEditorRequest = async (req, res, next) => {
        try {
          if (req.method === 'GET') {
            const markdown = await readFile(ALPHAFOLD2_MDX_PATH, 'utf8');
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(JSON.stringify({ markdown, path: ALPHAFOLD2_MDX_PATH }));
            return;
          }

          if (req.method === 'POST') {
            let body = '';
            req.setEncoding('utf8');
            for await (const chunk of req) body += chunk;

            const payload = JSON.parse(body);
            if (typeof payload.markdown !== 'string') {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Expected a string markdown field.' }));
              return;
            }

            await writeFile(ALPHAFOLD2_MDX_PATH, payload.markdown, 'utf8');
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }));
            return;
          }

          res.statusCode = 405;
          res.setHeader('allow', 'GET, POST');
          res.end(JSON.stringify({ error: 'Method not allowed.' }));
        } catch (error) {
          next(error);
        }
      };

      server.middlewares.use('/api/editor/alphafold2', handleEditorRequest);
    },
  };
}

export default defineConfig({
  site: 'https://annotated.chrishayduk.com',
  output: 'static',
  integrations: [
    mdx(),
    react(),
    sitemap({
      filter: (page) => !page.endsWith('/editor/'),
    }),
  ],
  markdown: {
    shikiConfig: { theme: 'github-dark-dimmed', wrap: true },
    remarkPlugins: [remarkMath],
    rehypePlugins: [
      rehypeSlug,
      [rehypeAutolinkHeadings, { behavior: 'append', properties: { className: ['heading-anchor'], ariaLabel: 'Link to section' } }],
      rehypeKatex,
    ],
  },
  vite: {
    plugins: [tailwindcss(), alphaFoldEditorDevApi()],
    optimizeDeps: {
      exclude: ['3dmol'],
    },
  },
});
