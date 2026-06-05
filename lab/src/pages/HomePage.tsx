import { useEffect, useMemo, useState } from 'react';
import { getServiceStatus } from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';
import ToolCard from '@/components/ToolCard';
import { TOOLS, resolvePostizUrl, type ToolDefinition } from '@/config/tools';

/**
 * The launcher hub at `/`. A config-driven grid of equal-sized tool cards.
 * Tiles are rendered straight from the `TOOLS` registry — adding a tool there
 * is the only change needed for a new tile to appear here.
 *
 * Two tiles resolve at runtime: external tools (Postiz) live on a separate
 * self-hosted service whose URL isn't known at build time. We fetch it from
 * `getServiceStatus` and, when Postiz isn't configured, downgrade the tile to
 * "coming soon" so it never opens a dead link.
 */
export default function HomePage() {
  const [postizUrl, setPostizUrl] = useState<string | null>(null);

  useEffect(() => {
    getServiceStatus({})
      .then((status) => setPostizUrl(resolvePostizUrl(status)))
      .catch(() => setPostizUrl(null));
  }, []);

  const tools = useMemo<ToolDefinition[]>(
    () =>
      TOOLS.map((tool) => {
        if (!tool.external) return tool;
        // External tools go live only when their URL resolves; otherwise they
        // stay "coming soon".
        return postizUrl
          ? { ...tool, href: postizUrl, status: 'live' as const }
          : { ...tool, href: undefined, status: 'coming-soon' as const };
      }),
    [postizUrl],
  );

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-6 py-12 sm:py-16">
        <header className="mb-10 text-center sm:text-left">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Your ClipMagic studio</h1>
          <p className="mt-2 text-muted-foreground">
            Pick a tool to get started. Everything you need to script, cut and ship short-form video.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      </div>
    </Layout>
  );
}
