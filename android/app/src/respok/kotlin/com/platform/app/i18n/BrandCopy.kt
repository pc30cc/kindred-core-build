package com.platform.app.i18n

/**
 * RESPOK's wording of the lines that name the product ([BrandStr]): the
 * desktop apps' own (windows-native's Localization/strings.respok.json, and
 * the Mac's mac-strings.respok.json for the maintenance title), word for
 * word, with the Turkish suffixes that agree with the name (RESPOK'tan).
 * RESPOK is Latin in every language, as on its desktop apps and its site.
 *
 * Only RESPOK's build has this file; the other flavor has its own
 * `BrandCopy` with the same functions.
 */
internal object BrandCopy {

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

    /** Turkish never named the product here: the line is the iOS app's own. */
    fun pushPresenceFooter(l: Language): String = when (l) {
        Language.EN -> "RESPOK knows you are at your desk while the web console is open. Turn the first off to keep the phone quiet while you are already answering there."
        Language.FA -> "RESPOK وقتی کنسول وب باز است می‌داند پشت میزتان هستید. اولی را خاموش کنید تا وقتی همان‌جا پاسخ می‌دهید، گوشی ساکت بماند."
        Language.TR -> "Web konsolu açıkken masanızda olduğunuz bilinir. Orada zaten yanıtlarken telefonun sessiz kalması için ilkini kapatın."
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
