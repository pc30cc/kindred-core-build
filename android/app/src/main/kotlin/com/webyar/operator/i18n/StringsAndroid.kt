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
}
