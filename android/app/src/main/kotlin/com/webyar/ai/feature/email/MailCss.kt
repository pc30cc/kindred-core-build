package com.webyar.ai.feature.email

/**
 * A mail's own stylesheet, confined to the mail.
 *
 * A mail's `<style>` was written for a page of its own: `body{min-width:600px}`,
 * `table{width:600px}`, `h1{font-size:32px}`. Dropped into the reader as they
 * are, those rules reach the whole page — the subject, the sender, the other
 * mails of the thread — and push all of it past the screen's edge. Here every
 * selector is put under the mail's own box (`.m0 table`), and what was aimed
 * at the page itself (`html`, `body`, `:root`) is aimed at that box instead,
 * the way web mail clients have always embedded mail.
 *
 * `@media` and `@supports` blocks are kept and scoped in turn — they are how a
 * newsletter reflows for a phone. `@font-face`, `@keyframes` and `@page` are
 * kept as they are: they name no elements. `@import` is dropped (it would
 * fetch a stylesheet from anywhere and apply it unscoped), and so is any other
 * at-rule this does not know.
 */
internal object MailCss {

    /** At-rules whose blocks hold more rules, which are scoped in turn. */
    private val GROUPING = setOf("media", "supports", "container", "layer", "document", "-moz-document")

    /** At-rules kept as written: their blocks are descriptors, not selectors. */
    private val VERBATIM = setOf(
        "font-face", "keyframes", "-webkit-keyframes", "-moz-keyframes", "page",
        "font-feature-values", "counter-style", "property",
    )

    private val COMMENT = Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL)

    /** `<!--` and `-->` around a whole stylesheet, from mail built for clients that showed it as text. */
    private val CDO_CDC = Regex("<!--|-->")

    /** A leading `html`/`:root` (with anything stuck to it) and a child combinator after it. */
    private val ROOT = Regex("^(?:html|:root)(?=$|[\\s>+~.#\\[:])[^\\s>+~]*\\s*(?:>\\s*)?", RegexOption.IGNORE_CASE)

    /** A leading `body` with anything stuck to it (`body.x`, `body[yahoo]`). */
    private val BODY = Regex("^body(?=$|[\\s>+~.#\\[:])[^\\s>+~]*", RegexOption.IGNORE_CASE)

    /** [css] with every rule applying inside `.[scope]` only. */
    fun scope(css: String, scope: String): String {
        val text = CDO_CDC.replace(COMMENT.replace(css, " "), " ")
        val out = StringBuilder(text.length + 64)
        rules(text, 0, text.length, ".$scope", out)
        return out.toString()
    }

    /** The rules of [css] between [from] and [to], scoped, onto [out]. */
    private fun rules(css: String, from: Int, to: Int, scope: String, out: StringBuilder) {
        var i = from
        while (i < to) {
            val c = css[i]
            if (c.isWhitespace() || c == ';' || c == '}') {
                i++
                continue
            }
            val stop = find(css, i, to) ?: return
            val prelude = css.substring(i, stop).trim()
            if (css[stop] == ';') {
                // A statement: @import, @charset, @namespace — none kept.
                i = stop + 1
                continue
            }
            val close = matching(css, stop, to)
            if (prelude.startsWith("@")) {
                val name = prelude.drop(1).takeWhile { it.isLetterOrDigit() || it == '-' }.lowercase()
                when (name) {
                    in GROUPING -> {
                        out.append(prelude).append('{')
                        rules(css, stop + 1, close, scope, out)
                        out.append('}')
                    }
                    in VERBATIM -> out.append(prelude).append('{').append(css, stop + 1, close).append('}')
                    else -> Unit
                }
            } else if (prelude.isNotEmpty()) {
                out.append(selectors(prelude, scope)).append('{').append(css, stop + 1, close).append('}')
            }
            i = close + 1
        }
    }

    /** Every selector of a list, scoped. */
    internal fun selectors(list: String, scope: String): String =
        split(list).joinToString(",") { one(it.trim(), scope) }

    private fun one(selector: String, scope: String): String {
        val rest = ROOT.replaceFirst(selector, "")
        if (rest.isEmpty()) return scope
        val body = BODY.find(rest) ?: return "$scope $rest"
        return scope + rest.substring(body.range.last + 1)
    }

    /** The next `{` or `;` at the top level from [from]: not inside a string, brackets or parentheses. */
    private fun find(css: String, from: Int, to: Int): Int? {
        var depth = 0
        var i = from
        while (i < to) {
            when (val c = css[i]) {
                '"', '\'' -> i = skipString(css, i, to, c)
                '(', '[' -> depth++
                ')', ']' -> if (depth > 0) depth--
                '{', ';' -> if (depth == 0) return i
            }
            i++
        }
        return null
    }

    /** The `}` that closes the block opened at [open]; [to] when the sheet ends first. */
    private fun matching(css: String, open: Int, to: Int): Int {
        var depth = 0
        var i = open
        while (i < to) {
            when (val c = css[i]) {
                '"', '\'' -> i = skipString(css, i, to, c)
                '{' -> depth++
                '}' -> if (--depth == 0) return i
            }
            i++
        }
        return to
    }

    /** The index of the quote that ends the string starting at [start]. */
    private fun skipString(css: String, start: Int, to: Int, quote: Char): Int {
        var i = start + 1
        while (i < to) {
            when (css[i]) {
                '\\' -> i++
                quote, '\n' -> return i
            }
            i++
        }
        return to - 1
    }

    /** A selector list split on its top-level commas. */
    private fun split(list: String): List<String> {
        val parts = ArrayList<String>(4)
        var depth = 0
        var start = 0
        var i = 0
        while (i < list.length) {
            when (val c = list[i]) {
                '"', '\'' -> i = skipString(list, i, list.length, c)
                '(', '[' -> depth++
                ')', ']' -> if (depth > 0) depth--
                ',' -> if (depth == 0) {
                    parts += list.substring(start, i)
                    start = i + 1
                }
            }
            i++
        }
        parts += list.substring(start)
        return parts.filter { it.isNotBlank() }
    }
}
