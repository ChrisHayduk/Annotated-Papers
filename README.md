# annotated-papers

Source for [annotated.chrishayduk.com](https://annotated.chrishayduk.com) — line-by-line walkthroughs of research papers in the tradition of [The Annotated Transformer](https://nlp.seas.harvard.edu/annotated-transformer/).

First paper: **AlphaFold2**, at `/alphafold2`.

## Stack

- **Astro** (static) + **MDX** + **React** islands
- **Tailwind v4** (via `@tailwindcss/vite`) with a class-strategy dark mode
- **KaTeX** for math, **Shiki** for syntax highlighting (build-time)
- **Content collections** with a typed `papers` schema; papers live under `src/content/papers/<slug>/index.mdx`
- **Git submodule** at `vendor/min-AlphaFold` supplies the code for `<Snippet file="..." lines="..." />`

## Commands

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `pnpm install`            | Install dependencies                             |
| `pnpm dev`                | Dev server at http://localhost:4321              |
| `pnpm build`              | Static build to `./dist/`                        |
| `pnpm preview`            | Preview the built site                           |
| `pnpm check`              | Astro type/schema check                          |
| `pnpm typecheck`          | `tsc --noEmit`                                   |
| `pnpm verify-snippets`    | Validate every `<Snippet>` / `<CodeRef>` resolves|

## First-time setup

```sh
git clone --recurse-submodules <this-repo>
cd annotated-papers
pnpm install
pnpm dev
```

If you cloned without `--recurse-submodules`:

```sh
git submodule update --init --recursive
```

## Adding a new paper

1. Create `src/content/papers/<slug>/index.mdx` with the frontmatter fields from `src/content.config.ts`.
2. Co-locate interactive components under `src/components/interactive/<slug>/`.
3. Reference code from the pinned submodule with `<Snippet file="minalphafold/..." lines="A-B" />` or `<Snippet file="..." symbol="ClassName" />`.
4. Run `pnpm verify-snippets` to confirm every reference resolves.

## Deployment

Cloudflare Pages. Production branch `main`; preview deploys on every other branch. Build command `pnpm install --frozen-lockfile && pnpm build`; output `dist`. Submodule fetch must be enabled in the Pages build settings so `vendor/min-AlphaFold` is populated at build time.

## Structure

```
src/
├── content/papers/<slug>/index.mdx       # each annotation
├── layouts/{BaseLayout,PaperLayout}.astro
├── components/
│   ├── mdx/                              # MDX-level primitives (Snippet, CodeRef, PaperQuote, ...)
│   ├── paper/                            # paper-page chrome (PaperHeader, TOC)
│   └── interactive/<slug>/               # React islands, hydrated with client:visible
├── lib/snippets.ts                       # build-time snippet extractor from vendor/min-AlphaFold
├── pages/
│   ├── index.astro                       # paper index
│   ├── [paper]/index.astro               # dynamic paper route
│   ├── about.astro
│   └── rss.xml.ts
├── scripts/verify-snippets.mjs           # CI check: every reference resolves
└── styles/{global,paper}.css
```
