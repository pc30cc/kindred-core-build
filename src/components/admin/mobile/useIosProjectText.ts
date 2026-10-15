import { useEdition } from '@/hooks/useEdition';
import { iosProjectText, type IosProjectText } from './iosProjectText';

/** iosProjectText for the platform's edition, for a component's t() params. */
export function useIosProjectText(): IosProjectText {
  const { edition } = useEdition();
  return iosProjectText(edition);
}
