package com.webyar.ai.i18n

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A name inside a sentence goes in between isolates.
 *
 * The inbox lays a preview out in the direction of its first strong letter,
 * and these sentences open with a person's name. Unisolated, «John این گفتگو
 * را به Sara منتقل کرد» becomes a left-to-right line that, read from the
 * right, says the conversation went to John; «علی sent a photo» in an English
 * list flips the same way.
 *
 * Plain JUnit: these strings touch nothing of the framework.
 */
class NameIsolationTest {

    private fun isolated(value: String) = "\u2068$value\u2069"

    @Test
    fun `a sender's name is isolated in the attachment previews`() {
        assertEquals("${isolated("علی رضایی")} sent a photo", StrManual.previewSentByImage(Language.EN, "علی رضایی"))
        assertEquals("${isolated("John")} یک فایل ارسال کرد", StrManual.previewSentByFile(Language.FA, "John"))
    }

    @Test
    fun `both names in a transfer are isolated`() {
        assertEquals(
            "${isolated("John")} این گفتگو را به ${isolated("Sara")} منتقل کرد",
            StrManual.sysTransferred(Language.FA, actor = "John", to = "Sara"),
        )
    }

    @Test
    fun `a rejected address keeps its trailing typo in place`() {
        assertEquals(
            "نشانی ایمیل معتبر نیست: ${isolated("ali@gmail.")}",
            StrEmail.invalidAddresses(Language.FA, "ali@gmail."),
        )
    }

    @Test
    fun `a duration is not a name and is left alone`() {
        assertEquals("Call ended · Duration 00:39", StrManual.callEndedBySystem(Language.EN, "00:39"))
    }
}
