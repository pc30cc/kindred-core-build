import Placeholder from './_PlaceholderPage';
import { MessageCircleQuestion } from 'lucide-react';
export default function QnaPage() {
  return <Placeholder icon={MessageCircleQuestion} title="Questions & Answers"
    description="Curated Q&A pairs the agent prefers over generated answers."
    bullets={['Locale-aware pairs', 'Enable / disable individual entries', 'Higher retrieval priority than KB articles']} />;
}