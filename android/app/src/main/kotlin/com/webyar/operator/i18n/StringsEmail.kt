package com.webyar.operator.i18n

/**
 * The mailbox's words — its folders, its composer, its trail.
 *
 * A file of their own because there are enough of them to be a screen's
 * vocabulary, and because none of them is used anywhere else.
 */
object StrEmail {
    fun folderInbox(l: Language): String = when (l) {
        Language.EN -> "Inbox"
        Language.FA -> "صندوق"
        Language.TR -> "Gelen kutusu"
    }

    fun folderUnread(l: Language): String = when (l) {
        Language.EN -> "Unread"
        Language.FA -> "خوانده‌نشده"
        Language.TR -> "Okunmamış"
    }

    fun folderStarred(l: Language): String = when (l) {
        Language.EN -> "Starred"
        Language.FA -> "ستاره‌دار"
        Language.TR -> "Yıldızlı"
    }

    fun compose(l: Language): String = when (l) {
        Language.EN -> "Compose"
        Language.FA -> "نوشتن"
        Language.TR -> "Yeni e-posta"
    }

    fun newMessage(l: Language): String = when (l) {
        Language.EN -> "New message"
        Language.FA -> "ایمیل جدید"
        Language.TR -> "Yeni ileti"
    }

    fun markRead(l: Language): String = when (l) {
        Language.EN -> "Mark as read"
        Language.FA -> "علامت خوانده‌شده"
        Language.TR -> "Okundu olarak işaretle"
    }

    fun markUnread(l: Language): String = when (l) {
        Language.EN -> "Mark as unread"
        Language.FA -> "علامت خوانده‌نشده"
        Language.TR -> "Okunmadı olarak işaretle"
    }

    fun star(l: Language): String = when (l) {
        Language.EN -> "Star"
        Language.FA -> "ستاره زدن"
        Language.TR -> "Yıldızla"
    }

    fun unstar(l: Language): String = when (l) {
        Language.EN -> "Remove star"
        Language.FA -> "برداشتن ستاره"
        Language.TR -> "Yıldızı kaldır"
    }

    fun reply(l: Language): String = when (l) {
        Language.EN -> "Reply"
        Language.FA -> "پاسخ"
        Language.TR -> "Yanıtla"
    }

    fun replyAll(l: Language): String = when (l) {
        Language.EN -> "Reply all"
        Language.FA -> "پاسخ به همه"
        Language.TR -> "Tümünü yanıtla"
    }

    fun forward(l: Language): String = when (l) {
        Language.EN -> "Forward"
        Language.FA -> "ارسال به دیگری"
        Language.TR -> "İlet"
    }

    fun to(l: Language): String = when (l) {
        Language.EN -> "To"
        Language.FA -> "به"
        Language.TR -> "Kime"
    }

    fun cc(l: Language): String = "Cc"

    fun bcc(l: Language): String = "Bcc"

    fun ccBcc(l: Language): String = when (l) {
        Language.EN -> "Cc / Bcc"
        Language.FA -> "رونوشت (Cc / Bcc)"
        Language.TR -> "Bilgi (Cc / Bcc)"
    }

    fun subject(l: Language): String = when (l) {
        Language.EN -> "Subject"
        Language.FA -> "موضوع"
        Language.TR -> "Konu"
    }

    fun body(l: Language): String = when (l) {
        Language.EN -> "Write your message"
        Language.FA -> "متن ایمیل را بنویسید"
        Language.TR -> "İletinizi yazın"
    }

    fun addressesHint(l: Language): String = when (l) {
        Language.EN -> "Separate addresses with a comma"
        Language.FA -> "نشانی‌ها را با ویرگول جدا کنید"
        Language.TR -> "Adresleri virgülle ayırın"
    }

    fun invalidAddresses(l: Language, bad: String): String = when (l) {
        Language.EN -> "Not an email address: $bad"
        Language.FA -> "نشانی ایمیل معتبر نیست: $bad"
        Language.TR -> "Geçerli bir e-posta adresi değil: $bad"
    }

    fun needsRecipient(l: Language): String = when (l) {
        Language.EN -> "Add at least one recipient"
        Language.FA -> "دست‌کم یک گیرنده وارد کنید"
        Language.TR -> "En az bir alıcı ekleyin"
    }

    fun needsSubject(l: Language): String = when (l) {
        Language.EN -> "Add a subject"
        Language.FA -> "موضوع را وارد کنید"
        Language.TR -> "Bir konu ekleyin"
    }

    fun addAttachment(l: Language): String = when (l) {
        Language.EN -> "Attach a file"
        Language.FA -> "افزودن پیوست"
        Language.TR -> "Dosya ekle"
    }

    fun removeAttachment(l: Language): String = when (l) {
        Language.EN -> "Remove attachment"
        Language.FA -> "حذف پیوست"
        Language.TR -> "Eki kaldır"
    }

    fun uploading(l: Language): String = when (l) {
        Language.EN -> "Uploading…"
        Language.FA -> "در حال بارگذاری…"
        Language.TR -> "Yükleniyor…"
    }

    fun uploadFailed(l: Language): String = when (l) {
        Language.EN -> "The file could not be attached"
        Language.FA -> "پیوست بارگذاری نشد"
        Language.TR -> "Dosya eklenemedi"
    }

    fun openFailed(l: Language): String = when (l) {
        Language.EN -> "No app on this phone can open this file"
        Language.FA -> "برنامه‌ای برای باز کردن این فایل روی گوشی نیست"
        Language.TR -> "Bu telefonda dosyayı açabilecek bir uygulama yok"
    }

    fun downloadFailed(l: Language): String = when (l) {
        Language.EN -> "The attachment could not be downloaded"
        Language.FA -> "پیوست دریافت نشد"
        Language.TR -> "Ek indirilemedi"
    }

    fun sent(l: Language): String = when (l) {
        Language.EN -> "Sent"
        Language.FA -> "ارسال شد"
        Language.TR -> "Gönderildi"
    }

    fun showQuoted(l: Language): String = when (l) {
        Language.EN -> "Show quoted text"
        Language.FA -> "نمایش متن نقل‌قول"
        Language.TR -> "Alıntıyı göster"
    }

    fun hideQuoted(l: Language): String = when (l) {
        Language.EN -> "Hide quoted text"
        Language.FA -> "پنهان کردن متن نقل‌قول"
        Language.TR -> "Alıntıyı gizle"
    }

    fun toLine(l: Language, who: String): String = when (l) {
        Language.EN -> "to $who"
        Language.FA -> "به $who"
        Language.TR -> "kime: $who"
    }

    fun me(l: Language): String = when (l) {
        Language.EN -> "me"
        Language.FA -> "من"
        Language.TR -> "ben"
    }

    fun messagesCount(l: Language, count: Int): String = when (l) {
        Language.EN -> if (count == 1) "1 message" else "$count messages"
        Language.FA -> "${Format.number(count, l)} پیام"
        Language.TR -> "$count ileti"
    }

    fun forwardedHeader(l: Language): String = when (l) {
        Language.EN -> "---------- Forwarded message ----------"
        Language.FA -> "---------- پیام ارسال‌شده ----------"
        Language.TR -> "---------- İletilen ileti ----------"
    }

    fun from(l: Language): String = when (l) {
        Language.EN -> "From"
        Language.FA -> "از"
        Language.TR -> "Kimden"
    }

    fun date(l: Language): String = when (l) {
        Language.EN -> "Date"
        Language.FA -> "تاریخ"
        Language.TR -> "Tarih"
    }

    fun discardDraft(l: Language): String = when (l) {
        Language.EN -> "Discard this draft?"
        Language.FA -> "این پیش‌نویس دور ریخته شود؟"
        Language.TR -> "Bu taslak silinsin mi?"
    }

    fun discard(l: Language): String = when (l) {
        Language.EN -> "Discard"
        Language.FA -> "دور ریختن"
        Language.TR -> "Sil"
    }

    fun keepEditing(l: Language): String = when (l) {
        Language.EN -> "Keep editing"
        Language.FA -> "ادامهٔ نوشتن"
        Language.TR -> "Düzenlemeye devam et"
    }

    fun endOfList(l: Language): String = when (l) {
        Language.EN -> "That's everything"
        Language.FA -> "همه همین بود"
        Language.TR -> "Hepsi bu kadar"
    }
}
