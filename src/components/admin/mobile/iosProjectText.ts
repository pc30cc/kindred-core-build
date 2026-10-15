/**
 * The native iOS project's names as Super Admin → Mobile app's texts show
 * them (`{{iosDir}}`, `{{iosProject}}`, `{{iosScheme}}`, `{{urlSchemeExample}}`
 * in admin.mobileApp.*).
 *
 * The Iranian edition (and an edition not known yet) reads the project's
 * exact folder and names, as the texts always said. The International
 * edition, and every RESPOK build (SHIPS_IRAN_KIT is false there, so the Iran
 * branch is not in its bundle), names them without the Iran brand: the
 * folder as a glob that matches it (`ios/*`), the scheme as its own.
 */
import { SHIPS_IRAN_KIT } from '../../../../shared/buildBrand';
import type { Edition } from '../../../../shared/edition';

export interface IosProjectText extends Record<string, string> {
  /** The project's folder, relative to the repository. */
  iosDir: string;
  /** The generated Xcode project, inside iosDir (a glob that matches it in the International edition). */
  iosProject: string;
  /** The scheme that builds the edition's app. */
  iosScheme: string;
  /** An example custom URL scheme. */
  urlSchemeExample: string;
}

export function iosProjectText(edition: Edition | null | undefined): IosProjectText {
  if (SHIPS_IRAN_KIT && edition !== 'international') {
    return { iosDir: 'ios/Webyar', iosProject: 'Webyar.xcodeproj', iosScheme: 'Webyar', urlSchemeExample: 'webyar' };
  }
  return { iosDir: 'ios/*', iosProject: '*.xcodeproj', iosScheme: 'Respok', urlSchemeExample: 'respok' };
}
