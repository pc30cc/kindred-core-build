package com.webyar.operator.core

import com.webyar.operator.core.model.CannedText
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The placeholder rule, which is a cross-surface contract rather than a
 * detail.
 *
 * The web, iOS and this app all have to fill the same six names the same way
 * and, above all, LEAVE THE REST ALONE. A greeting that silently becomes
 * "Hello ," has lost the operator's chance to notice; one that still reads
 * "Hello {{contact.name}}" cannot be sent by accident without being seen.
 */
class CannedTextTest {

    private val full = CannedText.Context(
        contactName = "مریم حسینی",
        contactEmail = "maryam@example.com",
        workspaceName = "Sample Workspace",
        agentName = "Sara Karimi",
        agentEmail = "operator@webyar.app",
    )

    @Test fun `every one of the six names resolves`() {
        assertEquals("مریم حسینی", CannedText.interpolate("{{contact.name}}", full))
        assertEquals("maryam@example.com", CannedText.interpolate("{{contact.email}}", full))
        assertEquals("Sample Workspace", CannedText.interpolate("{{workspace.name}}", full))
        assertEquals("Sara Karimi", CannedText.interpolate("{{agent.name}}", full))
        assertEquals("Sara", CannedText.interpolate("{{agent.first_name}}", full))
        assertEquals("operator@webyar.app", CannedText.interpolate("{{agent.email}}", full))
    }

    @Test fun `a name with no value keeps its braces`() {
        val anonymous = CannedText.Context(workspaceName = "Sample Workspace")
        assertEquals(
            "سلام {{contact.name}} عزیز، به Sample Workspace خوش آمدید.",
            CannedText.interpolate(
                "سلام {{contact.name}} عزیز، به {{workspace.name}} خوش آمدید.",
                anonymous,
            ),
        )
    }

    @Test fun `a blank value counts as no value`() {
        // Not the same as absent, and it must behave the same way: a contact
        // row with an empty string in it is common, and "Hello ," is the exact
        // outcome this rule exists to prevent.
        val blank = CannedText.Context(contactName = "   ")
        assertEquals("Hello {{contact.name}}", CannedText.interpolate("Hello {{contact.name}}", blank))
    }

    @Test fun `an unknown name is left exactly as written`() {
        assertEquals("{{order.total}}", CannedText.interpolate("{{order.total}}", full))
    }

    @Test fun `spaces inside the braces are allowed, as on the web`() {
        assertEquals("Sample Workspace", CannedText.interpolate("{{  workspace.name  }}", full))
    }

    @Test fun `a name that is not dotted lower-case is not a placeholder`() {
        // The pattern is deliberately narrow. Anything else in braces is text
        // somebody wrote, and rewriting it would be the app editing a reply.
        assertEquals("{{Contact.Name}}", CannedText.interpolate("{{Contact.Name}}", full))
        assertEquals("{{name}}", CannedText.interpolate("{{name}}", full))
    }

    @Test fun `several placeholders in one body all resolve independently`() {
        assertEquals(
            "Sara — Sample Workspace — {{contact.name}}",
            CannedText.interpolate(
                "{{agent.first_name}} — {{workspace.name}} — {{contact.name}}",
                CannedText.Context(agentName = "Sara Karimi", workspaceName = "Sample Workspace"),
            ),
        )
    }

    @Test fun `a body with no placeholders is returned untouched`() {
        assertEquals("همین الان بررسی می‌کنم.", CannedText.interpolate("همین الان بررسی می‌کنم.", full))
    }

    @Test fun `the agent's first name is the first word, not the first letter`() {
        val context = CannedText.Context(agentName = "  Ali Reza Ahmadi ")
        assertEquals("Ali", CannedText.interpolate("{{agent.first_name}}", context))
    }
}
