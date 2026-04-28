import Placeholder from './_PlaceholderPage';
import { ScrollText } from 'lucide-react';
export default function InstructionsPage() {
  return <Placeholder icon={ScrollText} title="Instructions" description="Tone, persona, forbidden topics, and escalation guidance for the agent."
    bullets={['Tone of voice', 'Forbidden topics list', 'Escalation phrases', 'Max answer length']} />;
}