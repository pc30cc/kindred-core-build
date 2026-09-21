package com.webyar.operator.i18n

import androidx.compose.ui.unit.LayoutDirection
import java.util.Locale

/**
 * The three languages the product ships in.
 *
 * The web app deliberately never reads the device language — the operator
 * picks one and it sticks. Both native apps keep that contract, so a user who
 * set Türkçe on the web does not get something else here. That is also why the
 * copy lives in [Str] rather than in `strings.xml`, which would resolve
 * against the device.
 */
enum class Language(val code: String) {
    EN("en"),
    FA("fa"),
    TR("tr");

    /** Written in the language itself, which is the only form a picker should show. */
    val endonym: String
        get() = when (this) {
            EN -> "English"
            FA -> "فارسی"
            TR -> "Türkçe"
        }

    val layoutDirection: LayoutDirection
        get() = if (this == FA) LayoutDirection.Rtl else LayoutDirection.Ltr

    val locale: Locale
        get() = when (this) {
            EN -> Locale.forLanguageTag("en-US")
            FA -> Locale.forLanguageTag("fa-IR")
            TR -> Locale.forLanguageTag("tr-TR")
        }

    companion object {
        fun from(code: String?): Language? = entries.firstOrNull { it.code == code }
        val DEFAULT = EN
    }
}
