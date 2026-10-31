/** The help center's default language: src/components/help/useHelpDefaultLocale.ts. */
import { Navigate } from 'react-router-dom';
import { useHelpDefaultLocale } from './useHelpDefaultLocale';

/** /help, and a help page asked for in an unknown language: the help center's front page in its default language. */
export function HelpDefaultRedirect() {
  const locale = useHelpDefaultLocale();
  if (!locale) return null;
  return <Navigate to={`/help/${locale}`} replace />;
}
