import Placeholder from './_PlaceholderPage';
import { Workflow } from 'lucide-react';
export default function WorkflowPage() {
  return <Placeholder icon={Workflow} title="Workflow builder" description="Visual flows that combine AI replies, conditions, and human handoff."
    bullets={['Drag-and-drop steps', 'Conditional branches', 'Reusable templates']} />;
}