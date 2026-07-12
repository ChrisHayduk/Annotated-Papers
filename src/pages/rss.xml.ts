import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const entries = await getCollection('papers', (e) => !e.data.draft);
  return rss({
    title: 'Annotated Papers by Chris Hayduk',
    description: 'Detailed annotations of research papers, with runnable code and interactive figures.',
    site: context.site ?? 'https://annotated.chrishayduk.com',
    items: entries
      .sort((a, b) => b.data.publishedDate.valueOf() - a.data.publishedDate.valueOf())
      .map((entry) => ({
        title: entry.data.title,
        description: entry.data.description,
        pubDate: entry.data.publishedDate,
        link: `/${entry.data.slug}/`,
      })),
  });
}
