import Placeholder from './_PlaceholderPage';
import { Route } from 'lucide-react';
export default function RoutingPage() {
  return <Placeholder icon={Route} title="Routing" description="Decide when the AI Agent should answer, suggest, or hand off to a human."
    bullets={['Auto-reply when offline', 'Hand off on low confidence', 'Department-aware routing']} />;
}