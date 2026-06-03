import Layout from '@/components/Layout';
import ToolCard from '@/components/ToolCard';
import { TOOLS } from '@/config/tools';

/**
 * The launcher hub at `/`. A config-driven grid of equal-sized tool cards.
 * Tiles are rendered straight from the `TOOLS` registry — adding a tool there
 * is the only change needed for a new tile to appear here.
 */
export default function HomePage() {
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
          {TOOLS.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      </div>
    </Layout>
  );
}
