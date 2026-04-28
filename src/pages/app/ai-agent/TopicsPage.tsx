import Placeholder from './_PlaceholderPage';
import { Tags } from 'lucide-react';
export default function TopicsPage() {
  return <Placeholder icon={Tags} title="Topic detection" description="Auto-classify visitor messages into topics for routing and analytics."
    bullets={['Custom topic taxonomy', 'Per-topic auto-actions', 'Reports by topic']} />;
}