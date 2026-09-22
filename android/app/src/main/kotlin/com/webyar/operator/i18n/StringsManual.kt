package com.webyar.operator.i18n

/**
 * The fourteen strings `strings-from-ios.mjs` will not generate.
 *
 * Every one of them is logic rather than copy: a placeholder to substitute, or
 * a plural whose English form changes at one. The generator refuses them on
 * purpose — a script that tried to translate `String.replacingOccurrences`
 * into Kotlin would be guessing, and a wrong guess here is a sentence with
 * `{actor}` still in it in front of an operator.
 *
 * The copy is still taken key for key from `Strings.swift`, so a change there
 * belongs here too. `StringsSyncTest` checks the generated file; these are on
 * the reader.
 */
object StrManual {

    // MARK: - Counts
    //
    // Only English changes shape at one. Persian and Turkish do not inflect
    // the noun for number, which is why neither has a branch.

    fun conversationsCount(l: Language, n: Int): String {
        val text = Format.number(n, l)
        return when (l) {
            Language.EN -> if (n == 1) "1 conversation" else "$text conversations"
            Language.FA -> "$text گفت‌وگو"
            Language.TR -> "$text görüşme"
        }
    }

    fun activeFilters(count: Int, l: Language): String {
        val text = Format.number(count, l)
        return when (l) {
            Language.EN -> if (count == 1) "1 filter" else "$text filters"
            Language.FA -> "$text پالایه"
            Language.TR -> "$text filtre"
        }
    }

    // MARK: - System notices
    //
    // The placeholders are braces rather than positional formats so that a
    // translator can move them, and so the two native apps share one spelling.

    fun sysTransferred(l: Language, actor: String, to: String): String = when (l) {
        Language.EN -> "{actor} transferred this conversation to {to}"
        Language.FA -> "{actor} این گفتگو را به {to} منتقل کرد"
        Language.TR -> "{actor} bu görüşmeyi {to} kişisine aktardı"
    }.replace("{actor}", actor).replace("{to}", to)

    fun sysUnassigned(l: Language, actor: String): String = when (l) {
        Language.EN -> "{actor} unassigned this conversation"
        Language.FA -> "{actor} این گفتگو را از حالت واگذارشده خارج کرد"
        Language.TR -> "{actor} bu görüşmenin atamasını kaldırdı"
    }.replace("{actor}", actor)

    fun sysAgentJoined(l: Language, name: String): String = when (l) {
        Language.EN -> "{name} joined the conversation"
        Language.FA -> "{name} به گفتگو پیوست"
        Language.TR -> "{name} sohbete katıldı"
    }.replace("{name}", name)

    fun sysCallInviteAudioFrom(l: Language, op: String): String = when (l) {
        Language.EN -> "{op} invited the visitor to an audio call"
        Language.FA -> "{op} کاربر را به تماس صوتی دعوت کرد"
        Language.TR -> "{op} ziyaretçiyi sesli aramaya davet etti"
    }.replace("{op}", op)

    fun sysCallInviteVideoFrom(l: Language, op: String): String = when (l) {
        Language.EN -> "{op} invited the visitor to a video call"
        Language.FA -> "{op} کاربر را به تماس تصویری دعوت کرد"
        Language.TR -> "{op} ziyaretçiyi görüntülü aramaya davet etti"
    }.replace("{op}", op)

    // MARK: - Call endings

    fun callEndedByOperator(l: Language, duration: String): String = when (l) {
        Language.EN -> "Call ended by operator · Duration {duration}"
        Language.FA -> "تماس از طرف اپراتور پایان یافت · مدت مکالمه {duration}"
        Language.TR -> "Görüşme operatör tarafından sonlandırıldı · Süre {duration}"
    }.replace("{duration}", duration)

    fun callEndedByVisitor(l: Language, duration: String): String = when (l) {
        Language.EN -> "Call ended by visitor · Duration {duration}"
        Language.FA -> "تماس از طرف کاربر پایان یافت · مدت مکالمه {duration}"
        Language.TR -> "Görüşme ziyaretçi tarafından sonlandırıldı · Süre {duration}"
    }.replace("{duration}", duration)

    fun callEndedBySystem(l: Language, duration: String): String = when (l) {
        Language.EN -> "Call ended · Duration {duration}"
        Language.FA -> "تماس پایان یافت · مدت مکالمه {duration}"
        Language.TR -> "Görüşme sona erdi · Süre {duration}"
    }.replace("{duration}", duration)

    // MARK: - Inbox previews
    //
    // An attachment-only message has no body to preview, so the list line is
    // written from the sender's name and the attachment's kind instead.

    fun previewSentByImage(l: Language, name: String): String = when (l) {
        Language.EN -> "{name} sent a photo"
        Language.FA -> "{name} یک تصویر ارسال کرد"
        Language.TR -> "{name} bir fotoğraf gönderdi"
    }.replace("{name}", name)

    fun previewSentByAudio(l: Language, name: String): String = when (l) {
        Language.EN -> "{name} sent a voice message"
        Language.FA -> "{name} یک پیام صوتی ارسال کرد"
        Language.TR -> "{name} bir sesli mesaj gönderdi"
    }.replace("{name}", name)

    fun previewSentByVideo(l: Language, name: String): String = when (l) {
        Language.EN -> "{name} sent a video"
        Language.FA -> "{name} یک ویدیو ارسال کرد"
        Language.TR -> "{name} bir video gönderdi"
    }.replace("{name}", name)

    fun previewSentByFile(l: Language, name: String): String = when (l) {
        Language.EN -> "{name} sent a file"
        Language.FA -> "{name} یک فایل ارسال کرد"
        Language.TR -> "{name} bir dosya gönderdi"
    }.replace("{name}", name)

    // MARK: - Android only
    //
    // `Strings.kt` is GENERATED from `Strings.swift` — anything written there
    // by hand is wiped the next time the generator runs, which is exactly how
    // these came to be missing once already. A string the iOS app has no use
    // for belongs here instead, where nothing overwrites it.

    /** The wordmark's fallback text, for talkback and for a failed font. */
    fun brandWordmark(l: Language): String = when (l) {
        Language.EN -> "Webyar"
        Language.FA -> "وب یار"
        Language.TR -> "Webyar"
    }

    /**
     * The voice note's two-state button. Android only: iOS draws an SF Symbol
     * with no label, so `Strings.swift` has neither word to generate from.
     */
    fun play(l: Language): String = when (l) {
        Language.EN -> "Play"
        Language.FA -> "پخش"
        Language.TR -> "Oynat"
    }

    fun pause(l: Language): String = when (l) {
        Language.EN -> "Pause"
        Language.FA -> "مکث"
        Language.TR -> "Duraklat"
    }

    /** A capability this workspace's plan does not include. */
    fun errorFeatureMissing(l: Language): String = when (l) {
        Language.EN -> "Your plan does not include this."
        Language.FA -> "پلن شما این امکان را ندارد."
        Language.TR -> "Planınız bunu içermiyor."
    }

    /**
     * Ending every other session at once.
     *
     * Android only: the endpoint has always existed
     * (`DELETE /api/account/security/sessions/:id?all=1`) and the iOS app does
     * not offer it, so there is no iOS copy to generate from.
     */
    fun signOutOtherDevices(l: Language): String = when (l) {
        Language.EN -> "Sign out on all other devices"
        Language.FA -> "خروج از همهٔ دستگاه‌های دیگر"
        Language.TR -> "Diğer tüm cihazlardan çık"
    }

    fun signOutOtherDevicesHelp(l: Language): String = when (l) {
        Language.EN -> "This device stays signed in."
        Language.FA -> "این دستگاه وارد می‌ماند."
        Language.TR -> "Bu cihaz oturumda kalır."
    }

    // MARK: - Notifications screen (Android only)

    fun notificationsLoadFailed(l: Language): String = when (l) {
        Language.EN -> "Notification settings could not be loaded."
        Language.FA -> "تنظیمات اعلان بارگذاری نشد."
        Language.TR -> "Bildirim ayarları yüklenemedi."
    }

    fun notificationsIntro(l: Language): String = when (l) {
        Language.EN -> "Choose how you want to manage your notifications."
        Language.FA -> "انتخاب کنید اعلان‌ها چطور مدیریت شوند."
        Language.TR -> "Bildirimlerinizi nasıl yöneteceğinizi seçin."
    }

    /** The switch itself, under iOS's "Quiet hours" heading. */
    fun notificationsQuietEnable(l: Language): String = when (l) {
        Language.EN -> "Enable quiet hours"
        Language.FA -> "فعال‌سازی ساعت سکوت"
        Language.TR -> "Sessiz saatleri aç"
    }

    /**
     * There is no Save button: a switch writes as it is flipped. Android says
     * so where iOS does not have to, because iOS settings screens are a
     * grouped list a person already reads as immediate.
     */
    fun notificationsSaving(l: Language): String = when (l) {
        Language.EN -> "Saving…"
        Language.FA -> "در حال ذخیره…"
        Language.TR -> "Kaydediliyor…"
    }

    fun notificationsAutoSaved(l: Language): String = when (l) {
        Language.EN -> "Automatically saved"
        Language.FA -> "به‌صورت خودکار ذخیره می‌شود"
        Language.TR -> "Otomatik kaydedilir"
    }
}
