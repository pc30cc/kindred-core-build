import Placeholder from './_PlaceholderPage';
import { Globe } from 'lucide-react';
export default function WebPagesPage() {
  return <Placeholder icon={Globe} title="Web pages" description="Crawl public web pages and use them as agent knowledge sources."
    bullets={['Sitemap-aware crawl', 'Per-URL refresh schedule', 'Reuses the existing AI KB crawler']} />;
}