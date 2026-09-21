package com.webyar.operator.i18n

import java.text.NumberFormat

/**
 * Numbers in the reader's own digits.
 *
 * A Persian operator reads ۱۲۳, not 123, and `NumberFormat` for `fa-IR`
 * already knows that — which is why this is one line rather than a digit
 * table. The port of `Format.number` in `DesignSystem/Formatting.swift`.
 *
 * Date formatting is not here yet: it arrives with the screens that show
 * dates, and the iOS original carries a formatter cache that only earns its
 * place once a scrolling list is formatting one per row per frame.
 */
object Format {
    fun number(value: Int, language: Language): String =
        NumberFormat.getIntegerInstance(language.locale).format(value.toLong())
}
