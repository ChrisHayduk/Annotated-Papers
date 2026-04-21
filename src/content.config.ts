// Import zod directly — the `z` re-export from 'astro:content' is deprecated
// in Astro 6 in favor of consuming zod from its own package.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'zod';

const papers = defineCollection({
  loader: glob({ pattern: '**/index.mdx', base: './src/content/papers' }),
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    authors: z.array(z.string()),
    annotator: z.string().default('Chris Hayduk'),
    paperYear: z.number(),
    arxivId: z.string().optional(),
    doi: z.string().optional(),
    venue: z.string().optional(),
    publishedDate: z.date(),
    updatedDate: z.date().optional(),
    referenceRepo: z
      .object({
        url: z.url(),
        commit: z.string(),
      })
      .optional(),
    tags: z.array(z.string()).default([]),
    readingTimeMinutes: z.number().optional(),
    heroFigure: z.string().optional(),
    description: z.string(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { papers };
