package com.platform.app.i18n

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Method
import java.lang.reflect.Modifier

/**
 * RESPOK's wording of the lines that name the product (its `BrandCopy`):
 * every one of them, never the other brand's name, its own name in each
 * (but the one line Turkish words without a name), Turkish suffixes that
 * agree with it, Latin in every language.
 */
class BrandCopyTest {

    /** The Iranian edition's name in any spelling: Latin (not the Turkish "Web yardım"), Persian. */
    private val otherBrand = Regex("[Ww][Ee][Bb] ?[Yy][Aa][Rr](?!\\p{Ll})|وب[‌ ]?یار|وبیار")

    private fun lines(table: Any): Map<String, Method> =
        table.javaClass.declaredMethods
            .filter { Modifier.isPublic(it.modifiers) && it.returnType == String::class.java }
            .filter { it.parameterTypes.toList() == listOf(Language::class.java) }
            .associateBy { it.name }

    private val copy = lines(BrandCopy)

    @Test
    fun `RESPOK has its own wording of every brand line, and it never names the other brand`() {
        assertEquals(lines(BrandStr).keys, copy.keys)
        for ((name, method) in copy) {
            for (l in Language.entries) {
                val text = method.invoke(BrandCopy, l) as String
                assertFalse("$name ${l.code}: $text", otherBrand.containsMatchIn(text))
                assertTrue("$name ${l.code} is blank", text.isNotBlank())
            }
        }
    }

    @Test
    fun `RESPOK's wording names RESPOK, except where the line never named the product`() {
        for ((name, method) in copy) {
            for (l in Language.entries) {
                val text = method.invoke(BrandCopy, l) as String
                if ("RESPOK" in text) continue
                // The one line Turkish words without a name.
                assertEquals("$name ${l.code}", "pushPresenceFooter" to Language.TR, name to l)
            }
        }
    }

    @Test
    fun `Turkish suffixes agree with RESPOK`() {
        assertEquals("RESPOK'tan çıkılsın mı?", BrandCopy.signOutConfirm(Language.TR))
        for (method in copy.values) {
            assertFalse(Regex("RESPOK['’](ı|ın|dan)\\b").containsMatchIn(method.invoke(BrandCopy, Language.TR) as String))
        }
    }

    @Test
    fun `RESPOK is Latin in every language, as on its desktop apps`() {
        for (l in Language.entries) {
            assertEquals("RESPOK", BrandCopy.appName(l))
            assertEquals("RESPOK", BrandCopy.brandWordmark(l))
        }
    }
}
