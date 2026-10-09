package com.webyar.ai.i18n

import com.webyar.ai.core.AppBrand

/**
 * The lines of copy that name the product, per brand.
 *
 * [Str] holds WebYar's wording and stays exactly what
 * `scripts/android/strings-from-ios.mjs` generates from the iOS app's
 * `Strings.swift`; [StrManual.brandWordmark] and [StrAndroid.maintenanceTitle]
 * are WebYar's hand-written ones. So the brand is chosen here, one level up,
 * as the iOS app's `BrandStr` does: WebYar's build returns that line
 * unchanged, RESPOK's build its own ([RespokStr]). Every screen that shows one
 * of these asks `BrandStr`, never `Str`, `StrManual` or `StrAndroid` directly
 * (src/test/apps/mobileBrands.android.test.ts holds every call site to that).
 */
object BrandStr {

    /** The product's name inside a sentence and for TalkBack. */
    fun appName(l: Language): String = if (AppBrand.isRespok) RespokStr.appName(l) else Str.appName(l)

    /** The wordmark above the login form and on a promotion without art (`BrandWordmark`). */
    fun brandWordmark(l: Language): String =
        if (AppBrand.isRespok) RespokStr.brandWordmark(l) else StrManual.brandWordmark(l)

    fun pushPrimerBody(l: Language): String =
        if (AppBrand.isRespok) RespokStr.pushPrimerBody(l) else Str.pushPrimerBody(l)

    fun pushDeniedTitle(l: Language): String =
        if (AppBrand.isRespok) RespokStr.pushDeniedTitle(l) else Str.pushDeniedTitle(l)

    fun pushPresenceFooter(l: Language): String =
        if (AppBrand.isRespok) RespokStr.pushPresenceFooter(l) else Str.pushPresenceFooter(l)

    fun signOutConfirm(l: Language): String =
        if (AppBrand.isRespok) RespokStr.signOutConfirm(l) else Str.signOutConfirm(l)

    /** Super Admin's maintenance notice, and the API's `maintenance` error (`ApiErrorText`). */
    fun maintenanceTitle(l: Language): String =
        if (AppBrand.isRespok) RespokStr.maintenanceTitle(l) else StrAndroid.maintenanceTitle(l)
}

/**
 * RESPOK's wording of those lines: the desktop apps' own
 * (windows-native/src/Webyar.Core/Localization/strings.respok.json, and the
 * Mac's mac-strings.respok.json for the maintenance title), word for word,
 * with the Turkish suffixes that agree with the name (RESPOK'tan). RESPOK is
 * Latin in every language, as on its desktop apps and its site.
 *
 * Compiled into both brands so that both brands' tests can read it; only
 * RESPOK's build ever shows it.
 */
internal object RespokStr {

    fun appName(l: Language): String = when (l) {
        Language.EN -> "RESPOK"
        Language.FA -> "RESPOK"
        Language.TR -> "RESPOK"
    }

    fun brandWordmark(l: Language): String = when (l) {
        Language.EN -> "RESPOK"
        Language.FA -> "RESPOK"
        Language.TR -> "RESPOK"
    }

    fun pushPrimerBody(l: Language): String = when (l) {
        Language.EN -> "RESPOK can tell you about new messages, mentions and internal notes — even when the app is closed. You choose exactly which, and you can change it any time in Settings."
        Language.FA -> "RESPOK می‌تواند پیام‌های تازه، نام‌بردن‌ها و یادداشت‌های داخلی را به شما خبر دهد — حتی وقتی برنامه بسته است. خودتان انتخاب می‌کنید کدام‌ها، و هر وقت خواستید از تنظیمات عوضش می‌کنید."
        Language.TR -> "RESPOK yeni mesajları, bahsetmeleri ve dahili notları — uygulama kapalıyken bile — size bildirebilir. Hangilerini istediğinizi siz seçersiniz ve istediğiniz zaman Ayarlar'dan değiştirebilirsiniz."
    }

    fun pushDeniedTitle(l: Language): String = when (l) {
        Language.EN -> "Notifications are off for RESPOK"
        Language.FA -> "اعلان‌های RESPOK خاموش است"
        Language.TR -> "RESPOK için bildirimler kapalı"
    }

    /** Turkish never named the product here, so that line is WebYar's own. */
    fun pushPresenceFooter(l: Language): String = when (l) {
        Language.EN -> "RESPOK knows you are at your desk while the web console is open. Turn the first off to keep the phone quiet while you are already answering there."
        Language.FA -> "RESPOK وقتی کنسول وب باز است می‌داند پشت میزتان هستید. اولی را خاموش کنید تا وقتی همان‌جا پاسخ می‌دهید، گوشی ساکت بماند."
        Language.TR -> Str.pushPresenceFooter(l)
    }

    fun signOutConfirm(l: Language): String = when (l) {
        Language.EN -> "Sign out of RESPOK?"
        Language.FA -> "از RESPOK خارج می‌شوید؟"
        Language.TR -> "RESPOK'tan çıkılsın mı?"
    }

    /** The Mac app's words (macos/Brands/Respok/mac-strings.respok.json). */
    fun maintenanceTitle(l: Language): String = when (l) {
        Language.EN -> "RESPOK is under maintenance"
        Language.FA -> "RESPOK در حال تعمیر و نگهداری است"
        Language.TR -> "RESPOK bakımda"
    }
}
