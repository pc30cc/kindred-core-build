package com.platform.app.i18n

/**
 * WebYar's wording of the lines that name the product ([BrandStr]): exactly
 * what the app showed before RESPOK existed.
 *
 * Most are the iOS app's own, generated into [StrBrand]
 * (`scripts/android/strings-from-ios.mjs`); the wordmark and the maintenance
 * title are Android's, hand-written here. Only WebYar's build has this file;
 * RESPOK's has its own `BrandCopy` with the same functions.
 */
internal object BrandCopy {

    fun appName(l: Language): String = StrBrand.appName(l)

    /** The wordmark's fallback text, for talkback and for a failed font. */
    fun brandWordmark(l: Language): String = when (l) {
        Language.EN -> "Webyar"
        Language.FA -> "وب یار"
        Language.TR -> "Webyar"
    }

    fun pushPrimerBody(l: Language): String = StrBrand.pushPrimerBody(l)

    fun pushDeniedTitle(l: Language): String = StrBrand.pushDeniedTitle(l)

    fun pushPresenceFooter(l: Language): String = StrBrand.pushPresenceFooter(l)

    fun signOutConfirm(l: Language): String = StrBrand.signOutConfirm(l)

    /** Super Admin's maintenance notice, in the Mac app's words. */
    fun maintenanceTitle(l: Language): String = when (l) {
        Language.EN -> "Webyar is under maintenance"
        Language.FA -> "وب‌یار در حال تعمیر و نگهداری است"
        Language.TR -> "Webyar bakımda"
    }
}
