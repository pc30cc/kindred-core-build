import Placeholder from './_PlaceholderPage';
import { FileText } from 'lucide-react';
export default function FilesPage() {
  return <Placeholder icon={FileText} title="Files" description="Upload PDFs, docs, and Markdown to extend the agent's knowledge."
    bullets={['PDF / DOCX / Markdown', 'Workspace-scoped storage', 'Indexed with KB articles']} />;
}