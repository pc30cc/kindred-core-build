package com.webyar.operator.i18n

/**
 * Strings this platform needs and iOS does not.
 *
 * Kept apart from both [Str] (generated from `Strings.swift`) and [StrManual]
 * (the fourteen the generator refuses) so that the sync between the two apps
 * stays legible: anything in those two files has a Swift counterpart and must
 * keep agreeing with it, and anything here does not and never will.
 *
 * The reason there is anything here at all is that the two platforms hand
 * different amounts of chrome to the developer. SwiftUI's `NavigationStack`
 * draws its own back button with the system's own translated label; Compose's
 * `TopAppBar` gives you an empty slot and expects a content description, so
 * the word has to exist somewhere.
 */
object StrAndroid {

    /** The back arrow's spoken label. Drawn as a glyph, never as text. */
    fun back(l: Language): String = when (l) {
        Language.EN -> "Back"
        Language.FA -> "بازگشت"
        Language.TR -> "Geri"
    }

    /** The overflow menu's spoken label. */
    fun moreOptions(l: Language): String = when (l) {
        Language.EN -> "More options"
        Language.FA -> "گزینه‌های بیشتر"
        Language.TR -> "Diğer seçenekler"
    }

    /** Clears a search field. Drawn as an ×. */
    fun clearSearch(l: Language): String = when (l) {
        Language.EN -> "Clear search"
        Language.FA -> "پاک کردن جست‌وجو"
        Language.TR -> "Aramayı temizle"
    }

    // MARK: - Offline and the outbox

    /**
     * The line above a list that is on screen from the cache while the server
     * cannot be reached. Says what the operator is looking at, not what went
     * wrong with the socket.
     */
    fun showingSaved(l: Language): String = when (l) {
        Language.EN -> "Offline — showing what was saved on this phone"
        Language.FA -> "آفلاین — آنچه روی این گوشی ذخیره شده نمایش داده می‌شود"
        Language.TR -> "Çevrimdışı — bu telefonda kayıtlı olanlar gösteriliyor"
    }

    /** Under a bubble the server has not confirmed yet. */
    fun messageSending(l: Language): String = when (l) {
        Language.EN -> "Sending…"
        Language.FA -> "در حال ارسال…"
        Language.TR -> "Gönderiliyor…"
    }

    /** Under a bubble that could not be sent. The bubble itself is the button. */
    fun messageNotSent(l: Language): String = when (l) {
        Language.EN -> "Not sent. Tap for options."
        Language.FA -> "ارسال نشد. برای گزینه‌ها ضربه بزنید."
        Language.TR -> "Gönderilmedi. Seçenekler için dokunun."
    }

    /** Takes an unsent message out of the thread. It was never on the server. */
    fun discardMessage(l: Language): String = when (l) {
        Language.EN -> "Delete"
        Language.FA -> "حذف"
        Language.TR -> "Sil"
    }

    /** On a photo that Data Saver kept from downloading by itself. */
    fun tapToLoad(l: Language): String = when (l) {
        Language.EN -> "Tap to load"
        Language.FA -> "برای بارگیری ضربه بزنید"
        Language.TR -> "Yüklemek için dokunun"
    }

    // MARK: - Storage

    fun storage(l: Language): String = when (l) {
        Language.EN -> "Storage"
        Language.FA -> "فضای ذخیره‌سازی"
        Language.TR -> "Depolama"
    }

    fun storageConversations(l: Language): String = when (l) {
        Language.EN -> "Conversations and messages"
        Language.FA -> "گفت‌وگوها و پیام‌ها"
        Language.TR -> "Görüşmeler ve mesajlar"
    }

    fun storageImages(l: Language): String = when (l) {
        Language.EN -> "Pictures"
        Language.FA -> "تصاویر"
        Language.TR -> "Görseller"
    }

    fun storageMedia(l: Language): String = when (l) {
        Language.EN -> "Files, voice notes and videos"
        Language.FA -> "فایل‌ها، پیام‌های صوتی و ویدیوها"
        Language.TR -> "Dosyalar, sesli notlar ve videolar"
    }

    fun storageTotal(l: Language): String = when (l) {
        Language.EN -> "Total"
        Language.FA -> "مجموع"
        Language.TR -> "Toplam"
    }

    fun storageCalculating(l: Language): String = when (l) {
        Language.EN -> "Calculating…"
        Language.FA -> "در حال محاسبه…"
        Language.TR -> "Hesaplanıyor…"
    }

    fun clearCache(l: Language): String = when (l) {
        Language.EN -> "Clear cache"
        Language.FA -> "پاک کردن حافظهٔ موقت"
        Language.TR -> "Önbelleği temizle"
    }

    /**
     * What Clear Cache does and, as importantly, what it does not: nothing
     * leaves the account, nobody is signed out, no setting changes.
     */
    fun clearCacheBody(l: Language): String = when (l) {
        Language.EN -> "Saved conversations, pictures and files are removed from this phone. " +
            "Nothing is deleted from your account, you stay signed in, and everything is " +
            "downloaded again when you need it. Messages still waiting to send are kept."
        Language.FA -> "گفت‌وگوها، تصاویر و فایل‌های ذخیره‌شده از این گوشی پاک می‌شوند. " +
            "چیزی از حساب شما حذف نمی‌شود، از حساب خارج نمی‌شوید و هر چیز در صورت نیاز " +
            "دوباره دریافت می‌شود. پیام‌هایی که هنوز در انتظار ارسال‌اند نگه داشته می‌شوند."
        Language.TR -> "Kayıtlı görüşmeler, görseller ve dosyalar bu telefondan kaldırılır. " +
            "Hesabınızdan hiçbir şey silinmez, oturumunuz açık kalır ve her şey gerektiğinde " +
            "yeniden indirilir. Gönderilmeyi bekleyen mesajlar korunur."
    }

    fun cacheCleared(l: Language): String = when (l) {
        Language.EN -> "Cache cleared"
        Language.FA -> "حافظهٔ موقت پاک شد"
        Language.TR -> "Önbellek temizlendi"
    }

    // MARK: - Notifications
    //
    // Channel names are shown by the SYSTEM, in its notification settings, so
    // they are written in the operator's chosen language when the channel is
    // created and rewritten when the language changes.

    fun channelMessages(l: Language): String = when (l) {
        Language.EN -> "Messages"
        Language.FA -> "پیام‌ها"
        Language.TR -> "Mesajlar"
    }

    fun channelMessagesDescription(l: Language): String = when (l) {
        Language.EN -> "New messages in your conversations"
        Language.FA -> "پیام‌های تازه در گفت‌وگوهای شما"
        Language.TR -> "Görüşmelerinizdeki yeni mesajlar"
    }

    /** A notification whose push carried no title of its own. */
    fun newMessage(l: Language): String = when (l) {
        Language.EN -> "New message"
        Language.FA -> "پیام تازه"
        Language.TR -> "Yeni mesaj"
    }

    // MARK: - Adaptive layout and appearance

    /** The detail pane beside the inbox on a tablet, before a row is picked. */
    fun pickConversation(l: Language): String = when (l) {
        Language.EN -> "Pick a conversation to read it here"
        Language.FA -> "یک گفتگو را انتخاب کنید تا اینجا نمایش داده شود"
        Language.TR -> "Burada okumak için bir konuşma seçin"
    }

    /** The detail pane beside the contacts on a tablet. */
    fun pickContact(l: Language): String = when (l) {
        Language.EN -> "Pick a contact to see their details"
        Language.FA -> "یک مخاطب را انتخاب کنید تا جزئیاتش را ببینید"
        Language.TR -> "Ayrıntıları görmek için bir kişi seçin"
    }

    /** Any other detail pane beside a list, before anything is picked. */
    fun pickItem(l: Language): String = when (l) {
        Language.EN -> "Pick an item to see it here"
        Language.FA -> "یک مورد را انتخاب کنید تا اینجا نمایش داده شود"
        Language.TR -> "Burada görmek için bir öğe seçin"
    }

    /** Settings → Appearance: Material You colours from the wallpaper. */
    fun wallpaperColors(l: Language): String = when (l) {
        Language.EN -> "Wallpaper colours"
        Language.FA -> "رنگ‌های والپیپر"
        Language.TR -> "Duvar kâğıdı renkleri"
    }

    fun wallpaperColorsBody(l: Language): String = when (l) {
        Language.EN -> "Use colours from your wallpaper instead of the brand's"
        Language.FA -> "به‌جای رنگ‌های برند، از رنگ‌های والپیپر استفاده شود"
        Language.TR -> "Marka renkleri yerine duvar kâğıdındaki renkleri kullan"
    }

    /** Spoken label of the button that jumps to the newest message. */
    fun jumpToLatest(l: Language): String = when (l) {
        Language.EN -> "Jump to the latest message"
        Language.FA -> "رفتن به آخرین پیام"
        Language.TR -> "Son mesaja git"
    }

    /** Ends a recording and keeps it, to be heard and then sent or thrown away. */
    fun stopRecording(l: Language): String = when (l) {
        Language.EN -> "Stop recording"
        Language.FA -> "پایان ضبط"
        Language.TR -> "Kaydı durdur"
    }
}
