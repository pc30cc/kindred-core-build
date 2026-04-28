import Placeholder from './_PlaceholderPage';
import { Bell } from 'lucide-react';
export default function TriggersPage() {
  return <Placeholder icon={Bell} title="Message triggers" description="Proactive messages based on visitor behavior or page context."
    bullets={['On page URL match', 'After N seconds of inactivity', 'Cart-abandon style flows']} />;
}