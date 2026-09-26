package com.webyar.operator.feature.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import com.webyar.operator.core.model.MobileAppConfig
import com.webyar.operator.core.model.Promotions
import com.webyar.operator.core.storage.Appearance
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.ui.A11y
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Super Admin → Mobile App → Android, as the operator's phone experiences it.
 *
 * Each switch is a promise made on the web — "operators will not see
 * Storage", "the name cannot be changed from the phone" — and the only place
 * it is kept is here, so each is checked by what is and is not on screen.
 */
@RunWith(RobolectricTestRunner::class)
// Tall enough for every section to compose: a `LazyColumn` in a phone-sized
// window never builds what is below the fold, and every "is not there"
// assertion would pass without testing anything.
@Config(sdk = [34], qualifiers = "w420dp-h3000dp")
class AdminSwitchesTest {

    @get:Rule val compose = createComposeRule()

    private val en = Language.EN

    private fun settings(
        showNotifications: Boolean = true,
        showSecurity: Boolean = true,
        onClearCache: (() -> Unit)? = {},
    ) = compose.setContent {
        SettingsScreen(
            language = en,
            appearance = Appearance.SYSTEM,
            account = AccountHeader("Sara Karimi", "operator@webyar.app", null),
            workspaces = emptyList(),
            selectedWorkspace = null,
            planName = null,
            availability = AvailabilityState.Loading,
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
            onClearCache = onClearCache,
            showNotifications = showNotifications,
            showSecurity = showSecurity,
        )
    }

    // MARK: - Settings

    @Test
    fun `every section is there by default`() {
        settings()
        compose.onNodeWithTag(A11y.SETTINGS_NOTIFICATIONS).assertIsDisplayed()
        compose.onNodeWithTag(A11y.SETTINGS_SECURITY).assertIsDisplayed()
        compose.onNodeWithTag(A11y.SETTINGS_STORAGE).assertIsDisplayed()
    }

    /** The route passes no Clear Cache when Super Admin hides Storage. */
    @Test
    fun `Storage hidden takes the whole section out`() {
        settings(onClearCache = null)
        compose.onNodeWithTag(A11y.SETTINGS_STORAGE).assertDoesNotExist()
        compose.onNodeWithText(StrAndroid.storage(en)).assertDoesNotExist()
    }

    @Test
    fun `Security hidden leaves Notifications on its own`() {
        settings(showSecurity = false)
        compose.onNodeWithTag(A11y.SETTINGS_SECURITY).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_NOTIFICATIONS).assertIsDisplayed()
    }

    @Test
    fun `Notifications hidden leaves Security under its own name`() {
        settings(showNotifications = false)
        compose.onNodeWithTag(A11y.SETTINGS_NOTIFICATIONS).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SECURITY).assertIsDisplayed()
        // The header is named for what is left, not for what was taken out.
        compose.onNodeWithText(Str.notifications(en)).assertDoesNotExist()
    }

    // MARK: - Profile

    private fun profile(
        phone: String = "",
        nameEditable: Boolean = false,
        phoneEditable: Boolean = false,
        photoEditable: Boolean = true,
    ) = compose.setContent {
        ProfileScreen(
            language = en,
            firstName = "Sara",
            lastName = "Karimi",
            email = "operator@webyar.app",
            phone = phone,
            avatarUrl = null,
            busy = false,
            error = null,
            onFirstNameChange = {},
            onLastNameChange = {},
            onPhoneChange = {},
            onPickAvatar = {},
            onRemoveAvatar = {},
            onSave = {},
            nameEditable = nameEditable,
            phoneEditable = phoneEditable,
            photoEditable = photoEditable,
        )
    }

    /** The default: the name is a fact, not a field. */
    @Test
    fun `a locked name is shown and cannot be edited`() {
        profile()
        compose.onNodeWithTag(A11y.PROFILE_NAME).assertIsDisplayed()
        compose.onNodeWithText("Sara Karimi").assertIsDisplayed()
        compose.onNodeWithTag(A11y.PROFILE_FIRST_NAME).assertDoesNotExist()
    }

    @Test
    fun `an editable name is a field again`() {
        profile(nameEditable = true)
        compose.onNodeWithTag(A11y.PROFILE_FIRST_NAME).assertIsDisplayed()
        compose.onNodeWithTag(A11y.PROFILE_NAME).assertDoesNotExist()
    }

    @Test
    fun `a phone number on file is shown`() {
        profile(phone = "+989121234567")
        compose.onNodeWithTag(A11y.PROFILE_PHONE).assertIsDisplayed()
        compose.onNodeWithText("+989121234567").assertIsDisplayed()
    }

    @Test
    fun `no phone number means no phone row`() {
        profile(phone = "")
        compose.onNodeWithTag(A11y.PROFILE_PHONE).assertDoesNotExist()
        compose.onNodeWithTag(A11y.PROFILE_PHONE_FIELD).assertDoesNotExist()
        compose.onNodeWithText(Str.phoneLabel(en)).assertDoesNotExist()
    }

    /** Allowed to change it, the operator can also add one they never had. */
    @Test
    fun `an editable phone is a field even when empty`() {
        profile(phone = "", phoneEditable = true)
        compose.onNodeWithTag(A11y.PROFILE_PHONE_FIELD).assertIsDisplayed()
    }

    @Test
    fun `nothing editable means no Save button`() {
        profile(phone = "+989121234567")
        compose.onNodeWithText(Str.save(en)).assertDoesNotExist()
    }

    @Test
    fun `photo locked hides the photo buttons`() {
        profile(photoEditable = false)
        compose.onNodeWithText(Str.changePhoto(en)).assertDoesNotExist()
    }

    // MARK: - What the server sends

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

    /** `GET /api/mobile-app/config?platform=android`, as the route writes it. */
    @Test
    fun `the config decodes from the server's own keys`() {
        val config = json.decodeFromString(
            MobileAppConfig.serializer(),
            """
            {"platform":"android","showStorage":false,"showSecurity":true,
             "showNotificationSettings":false,"allowWallpaperColors":false,
             "profileNameEditable":true,"profilePhoneEditable":true,"profilePhotoEditable":false}
            """.trimIndent(),
        )
        assertFalse(config.showStorage)
        assertFalse(config.showNotificationSettings)
        assertFalse(config.allowWallpaperColors)
        assertTrue(config.profileNameEditable)
        assertTrue(config.profilePhoneEditable)
        assertFalse(config.profilePhotoEditable)
    }

    /** An older server that sends nothing leaves the app as it always was, name locked. */
    @Test
    fun `a missing key takes its default`() {
        val config = json.decodeFromString(MobileAppConfig.serializer(), """{"platform":"android"}""")
        assertEquals(MobileAppConfig.DEFAULT, config)
        assertTrue(config.showStorage)
        assertFalse(config.profileNameEditable)
    }

    /**
     * `GET /api/mobile-app/promotions`, as `server/routes/mobilePromotions.ts`
     * writes it. The model once read snake_case keys, which decoded without a
     * complaint and dropped the button, the picture and the caps.
     */
    @Test
    fun `promotions decode from the server's own keys`() {
        val promotions = json.decodeFromString(
            Promotions.serializer(),
            """
            {"enabled":true,
             "banner":{"title":"T","body":"B","ctaLabel":"Go","ctaURL":"https://webyar.app/x","imageURL":"https://cdn/x.png"},
             "fullscreen":null,
             "minIntervalMinutes":360,"maxPerDay":3,"startAfterLaunches":2,
             "externalLinksAllowed":true}
            """.trimIndent(),
        )
        val banner = promotions.banner!!
        assertEquals("Go", banner.ctaLabel)
        assertEquals("https://webyar.app/x", banner.safeLink)
        assertEquals("https://cdn/x.png", banner.imageUrl)
        assertEquals(360, promotions.minIntervalMinutes)
        assertEquals(3, promotions.maxPerDay)
        assertEquals(2, promotions.startAfterLaunches)
    }
}
