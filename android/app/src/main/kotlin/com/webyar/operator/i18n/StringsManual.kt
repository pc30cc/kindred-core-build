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
}
