// Fills a saved reply's placeholders — the web's six names, and its rule that a
// placeholder with no value is left exactly as written. "Hello {{contact.name}}"
// is something an operator notices before sending; "Hello ," is not.

export interface CannedContext {
  contactName?: string | null
  contactEmail?: string | null
  workspaceName?: string | null
  agentName?: string | null
  agentEmail?: string | null
}

function value(name: string, c: CannedContext): string | null {
  const map: Record<string, string | null | undefined> = {
    'contact.name': c.contactName,
    'contact.email': c.contactEmail,
    'workspace.name': c.workspaceName,
    'agent.name': c.agentName,
    'agent.first_name': c.agentName?.split(' ')[0],
    'agent.email': c.agentEmail,
  }
  const v = map[name]
  return v && v.trim() ? v : null
}

export function interpolate(body: string, context: CannedContext): string {
  return body.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g, (whole, name: string) => value(name, context) ?? whole)
}
