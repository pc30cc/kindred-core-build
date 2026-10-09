/**
 * The native apps of each edition (shared/edition.ts). One source builds two
 * Windows apps and two Mac apps (windows-native/Directory.Build.props,
 * macos/project.yml), and two iOS and two Android apps: WebYar's for the
 * Iranian edition, RESPOK's for the International one. Each brand publishes
 * to its own feeds (.github/workflows/desktop-native.yml, macos.yml) and its
 * site serves its own downloads (deploy/app-downloads/).
 *
 * The Iranian edition's values are exactly the defaults it always had. In the
 * International edition, a stored value that still points at WebYar (a
 * database cloned from WebYar's) is never served: the RESPOK apps only trust
 * RESPOK's feeds, so a WebYar feed would switch their updates off.
 *
 * Super Admin keeps each edition's app settings apart (migration 257): an
 * edition that has saved nothing yet starts from these defaults.
 */
import type { Edition } from './edition.js';

export interface NativeAppBrand {
  /** The product's name in the apps. */
  name: string;
  /** Super Admin → Windows app: the default update feed (a trusted releases repository). */
  windowsFeedUrl: string;
  /** Super Admin → macOS app: the default Sparkle appcast. */
  macAppcastUrl: string;
  /** The installer CI publishes with each Windows release (a release asset). */
  windowsSetupFile: string;
  /**
   * What the site serves under /downloads/ for people to download, as zips: the newest
   * installer, and the newest DMG (deploy/app-downloads/). The old links to the installer
   * and the DMG themselves redirect to them.
   */
  windowsDownloadFile: string;
  macDownloadFile: string;
  /** The native iOS app's bundle identifier (ios/Webyar/project.yml). */
  iosBundleId: string;
  /** The Xcode scheme that builds the iOS app (ios/Webyar). */
  iosScheme: string;
  /** Super Admin → Mobile app → Android: the app's package (application id). */
  androidPackage: string;
  /**
   * The Gradle product flavor that builds the Android app (android/app/build.gradle.kts):
   * `:app:bundle<Flavor>Release`, and the prefix of its version properties (`-P<flavor>.versionName`).
   */
  androidFlavor: string;
  /** The APK the site hands out under /downloads/, and the sidecar naming its version (public/downloads/). */
  androidApkFile: string;
  androidReleaseFile: string;
}

export const NATIVE_APP_BRANDS: Readonly<Record<Edition, Readonly<NativeAppBrand>>> = {
  iran: {
    name: 'Webyar',
    windowsFeedUrl: 'https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download',
    macAppcastUrl: 'https://raw.githubusercontent.com/pc30cc/mac-os/main/appcast.xml',
    windowsSetupFile: 'Webyar-Setup.exe',
    windowsDownloadFile: 'Webyar-Windows.zip',
    macDownloadFile: 'Webyar-Mac.zip',
    iosBundleId: 'com.webyar.ai',
    iosScheme: 'Webyar',
    androidPackage: 'com.webyar.ai',
    androidFlavor: 'webyar',
    androidApkFile: 'Webyar-Android.apk',
    androidReleaseFile: 'Webyar-Android.json',
  },
  international: {
    name: 'RESPOK',
    windowsFeedUrl: 'https://github.com/pc30cc/respok-releases/releases/latest/download',
    macAppcastUrl: 'https://raw.githubusercontent.com/pc30cc/respok-releases/main/mac/appcast.xml',
    windowsSetupFile: 'RESPOK-Setup.exe',
    windowsDownloadFile: 'RESPOK-Windows.zip',
    macDownloadFile: 'RESPOK-Mac.zip',
    iosBundleId: 'com.respok.app',
    iosScheme: 'Respok',
    androidPackage: 'com.respok.app',
    androidFlavor: 'respok',
    androidApkFile: 'RESPOK-Android.apk',
    androidReleaseFile: 'RESPOK-Android.json',
  },
};

/** The brand of an edition; an unknown edition (null) is Iran, as everywhere else. */
export function nativeAppBrand(edition: Edition | null | undefined): Readonly<NativeAppBrand> {
  return NATIVE_APP_BRANDS[edition === 'international' ? 'international' : 'iran'];
}

/**
 * WebYar's own places: its name in any spelling, its domains and its feed repositories.
 * "Web yar" followed by a lowercase letter is a Turkish word ("Web yardım merkezi"), not WebYar;
 * an uppercase letter still is ("WebyarWindows", WebYar's package id).
 */
const WEBYAR_MARK = /[Ww][Ee][Bb] ?[Yy][Aa][Rr](?!\p{Ll})|وب[\u200c ]?یار|وبیار|pc30cc\/mac-os/u;

/** Does this stored value name or point at WebYar? */
export function pointsAtWebyar(value: unknown): boolean {
  return typeof value === 'string' && WEBYAR_MARK.test(value);
}
