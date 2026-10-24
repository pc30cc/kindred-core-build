package com.platform.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.unit.dp
import com.platform.app.core.net.SampleApi
import com.platform.app.core.storage.Appearance
import com.platform.app.feature.settings.AccountHeader
import com.platform.app.feature.settings.AvailabilityState
import com.platform.app.feature.settings.SettingsScreen
import com.platform.app.i18n.Language
import com.platform.app.ui.A11y
import com.platform.app.ui.design.AppTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The owner's rule for faces without a picture: a teammate (an operator, a
 * colleague, the operator themself) is the platform's person, and a
 * workspace whose owner set no logo is the platform's shop front. Never
 * initials, never a workspace's first letter, never an empty circle.
 *
 * The avatars clear their semantics for screen readers (the name beside them
 * is what is read), so these look in the unmerged tree, where whatever an
 * avatar draws is still listed: a letter put back inside one would show up
 * here as text.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class AvatarGlyphsTest {

    @get:Rule val compose = createComposeRule()

    /** Any node that says something: initials would be one. */
    private val saysSomething = SemanticsMatcher("has text") { node ->
        node.config.getOrNull(SemanticsProperties.Text)?.any { it.text.isNotBlank() } == true
    }

    @Test
    fun `an operator without a photo is the person glyph, not letters`() {
        compose.setContent {
            AppTheme(language = Language.FA, dark = false) {
                Column {
                    OperatorAvatar(imageUrl = null, size = 40.dp)
                    OperatorAvatar(imageUrl = "", size = 20.dp)
                }
            }
        }

        compose.onAllNodesWithTag(PERSON_GLYPH_TAG, useUnmergedTree = true).assertCountEquals(2)
        compose.onAllNodes(saysSomething, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun `a workspace without a logo is the shop front, not its first letter`() {
        compose.setContent {
            AppTheme(language = Language.EN, dark = true) {
                WorkspaceAvatar(logoUrl = null, size = 40.dp)
            }
        }

        compose.onAllNodesWithTag(WORKSPACE_GLYPH_TAG, useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodesWithTag(PERSON_GLYPH_TAG, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(saysSomething, useUnmergedTree = true).assertCountEquals(0)
    }

    /**
     * Settings → Workspace, with the sample workspaces, none of which has a
     * logo: each row carries the shop front, and nothing in a row is a
     * letter or two standing in for one.
     */
    @Test
    fun `the workspace rows in Settings show the shop front for a workspace without a logo`() {
        val api = SampleApi()
        val account = runBlocking { api.account() }
        val workspaces = runBlocking { api.workspaces() }
        val availability = runBlocking { api.availability() }
        check(workspaces.isNotEmpty() && workspaces.all { it.logoUrl.isNullOrBlank() })

        compose.setContent {
            AppTheme(language = Language.FA, dark = false) {
                SettingsScreen(
                    language = Language.FA,
                    appearance = Appearance.SYSTEM,
                    account = AccountHeader(account.profile?.fullName ?: "", account.email, null),
                    workspaces = workspaces,
                    selectedWorkspace = workspaces.first(),
                    planName = "Pro",
                    availability = AvailabilityState.Loaded(availability),
                    availabilitySaveFailed = false,
                    appVersion = "1.0 (1)",
                    onOpenProfile = {},
                    onOpenSecurity = {},
                    onOpenNotifications = {},
                    onSelectWorkspace = {},
                    onSelectLanguage = {},
                    onSelectAppearance = {},
                    onSetForceOffline = {},
                    onSetAvailableWhenUsingApp = {},
                    onSetScheduleEnabled = {},
                    onSignOut = {},
                    dynamicColor = false,
                )
            }
        }

        for (workspace in workspaces) {
            val inRow = hasAnyAncestor(hasTestTag(A11y.workspaceRow(workspace.id)))
            compose.onAllNodes(hasTestTag(WORKSPACE_GLYPH_TAG) and inRow, useUnmergedTree = true)
                .assertCountEquals(1)
            val letters = SemanticsMatcher("one or two letters") { node ->
                node.config.getOrNull(SemanticsProperties.Text)?.any { it.text.trim().length in 1..2 } == true
            }
            compose.onAllNodes(letters and inRow, useUnmergedTree = true).assertCountEquals(0)
        }
        // The operator's own card, without a photo in the sample: the person.
        compose.onAllNodesWithTag(PERSON_GLYPH_TAG, useUnmergedTree = true).assertCountEquals(1)
    }

    /**
     * The paths are the platform's (src/test/native/avatarGlyphs.test.ts
     * compares the strings); this checks Compose reads them as drawn: both
     * stand from y 3 to y 21 of the 24-unit grid, centred.
     */
    @Test
    fun `both glyphs fill their grid from three to twenty-one, centred`() {
        val person = PathParser().parsePathString(AvatarGlyphPaths.PERSON).toPath().getBounds()
        assertEquals(4f, person.left, 0.05f)
        assertEquals(3f, person.top, 0.05f)
        assertEquals(20f, person.right, 0.05f)
        assertEquals(21f, person.bottom, 0.05f)

        val workspace = PathParser().parsePathString(AvatarGlyphPaths.WORKSPACE).toPath().getBounds()
        assertEquals(2.5f, workspace.left, 0.05f)
        assertEquals(3f, workspace.top, 0.05f)
        assertEquals(21.5f, workspace.right, 0.05f)
        assertEquals(21f, workspace.bottom, 0.05f)
    }

    @Test
    fun `the glyphs take their share of the avatar, a little more on a small chip`() {
        assertEquals(0.62f, personBox(40.dp))
        assertEquals(0.68f, personBox(20.dp))
        assertEquals(0.58f, workspaceBox(40.dp))
        assertEquals(0.62f, workspaceBox(24.dp))
    }
}
