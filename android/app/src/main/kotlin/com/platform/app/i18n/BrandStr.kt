package com.platform.app.i18n

/**
 * The lines of copy that name the product, per brand.
 *
 * The words themselves are not in this file, nor anywhere in `src/main`:
 * they are each flavor's `BrandCopy` (src/<flavor>/kotlin/.../i18n), so a
 * build carries its own brand's lines and never the other's. RESPOK's APK
 * must not contain the other brand's name at all; a branch on the brand here
 * would compile both brands' words into both apps.
 *
 * [Str] is generated from the iOS app's `Strings.swift`; the generator
 * (`scripts/android/strings-from-ios.mjs`) leaves out every line that names
 * the product and writes those into the Iranian flavor's `StringsBrand.kt`,
 * which that flavor's `BrandCopy` returns. Every screen that shows one of
 * these asks `BrandStr`, never a flavor's table directly
 * (src/test/apps/mobileBrands.android.test.ts holds every call site to that).
 */
object BrandStr {

    /** The product's name inside a sentence and for TalkBack. */
    fun appName(l: Language): String = BrandCopy.appName(l)

    /** The wordmark above the login form and on a promotion without art (`BrandWordmark`). */
    fun brandWordmark(l: Language): String = BrandCopy.brandWordmark(l)

    fun pushPrimerBody(l: Language): String = BrandCopy.pushPrimerBody(l)

    fun pushDeniedTitle(l: Language): String = BrandCopy.pushDeniedTitle(l)

    fun pushPresenceFooter(l: Language): String = BrandCopy.pushPresenceFooter(l)

    fun signOutConfirm(l: Language): String = BrandCopy.signOutConfirm(l)

    /** Super Admin's maintenance notice, and the API's `maintenance` error (`ApiErrorText`). */
    fun maintenanceTitle(l: Language): String = BrandCopy.maintenanceTitle(l)
}
