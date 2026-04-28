import Placeholder from './_PlaceholderPage';
import { Plug } from 'lucide-react';
export default function IntegrationsPage() {
  return <Placeholder icon={Plug} title="Integrations & MCP" description="Connect the agent to your tools via MCP servers and direct integrations."
    bullets={['MCP servers (read / write tools)', 'Helpdesk + CRM integrations', 'Per-tool permission scopes']} />;
}