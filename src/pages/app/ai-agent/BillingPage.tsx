import Placeholder from './_PlaceholderPage';
import { CreditCard } from 'lucide-react';
export default function BillingPage() {
  return <Placeholder icon={CreditCard} title="Billing" description="Per-workspace AI Agent usage, credit consumption, and plan limits."
    bullets={['Credit usage by run type', 'Per-conversation reply caps', 'Plan upgrade hints']} />;
}