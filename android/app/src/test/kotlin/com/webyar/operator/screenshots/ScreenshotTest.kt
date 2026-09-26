package com.webyar.operator.screenshots

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.storage.Appearance
import com.webyar.operator.feature.auth.LoginScreen
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.chat.ChatState
import com.webyar.operator.feature.contacts.ContactsScreen
import com.webyar.operator.feature.contacts.ContactsState
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.feature.settings.AccountHeader
import com.webyar.operator.feature.settings.AvailabilityState
import com.webyar.operator.feature.settings.SettingsScreen
import com.webyar.operator.feature.settings.NotificationsScreen
import com.webyar.operator.feature.settings.NotificationsState
import com.webyar.operator.feature.settings.ProfileScreen
import com.webyar.operator.feature.settings.SecurityScreen
import com.webyar.operator.feature.contacts.ContactDetailScreen
import com.webyar.operator.feature.team.ColleaguesScreen
import com.webyar.operator.feature.team.ColleaguesState
import com.webyar.operator.feature.email.EmailInboxScreen
import com.webyar.operator.feature.email.EmailInboxState
import com.webyar.operator.core.model.VisitorProfile
import java.time.Instant
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.design.LocalReducedMotion
import com.webyar.operator.ui.design.WebyarTheme
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * What the main screens look like, as pictures.
 *
 * Not assertions: `./gradlew :app:recordRoborazziDebug` writes one PNG per
 * test to `build/outputs/roborazzi`, and the "Android screenshots" workflow
 * publishes them, so a change to the look can be seen and reviewed without a
 * device. In an ordinary test run nothing is recorded and each test only
 * proves the screen composes.
 *
 * Sample data only — the same [SampleApi] the debug build runs against — so
 * nothing here needs an account or a network.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = RobolectricDeviceQualifiers.Pixel7)
class ScreenshotTest {

    private val api = SampleApi()

    private fun shot(name: String, language: Language, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage("build/outputs/roborazzi/$name.png") {
            WebyarTheme(language = language, dark = dark) {
                // Loops hold still: a capture waits for the screen to go
                // idle, and a shape that turns forever never does.
                CompositionLocalProvider(LocalReducedMotion provides true) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        content()
                    }
                }
            }
        }
    }

    private fun inbox(name: String, language: Language, dark: Boolean) {
        val conversations = runBlocking { api.conversations("ws-1", InboxFilter.OPEN) }
        val intel = runBlocking { api.visitorIntelByConversation("ws-1", conversations.map { it.id }) }
        shot(name, language, dark) {
            InboxScreen(
                state = InboxState.Loaded(conversations),
                language = language,
                onOpen = {},
                intel = intel,
                chipFilters = listOf(InboxFilter.OPEN, InboxFilter.NEEDS_HUMAN),
                allFilters = InboxFilter.entries.toList(),
            )
        }
    }

    private fun chat(name: String, language: Language, dark: Boolean) {
        val conversation = runBlocking { api.conversations("ws-1", InboxFilter.OPEN) }.first()
        val messages = runBlocking { api.messages(conversation.id) }
        val intel = runBlocking { api.visitorIntelByConversation("ws-1", listOf(conversation.id)) }
        shot(name, language, dark) {
            ChatScreen(
                state = ChatState.Loaded(messages),
                language = language,
                onSend = {},
                onBack = {},
                conversation = conversation,
                visitor = intel[conversation.id],
            )
        }
    }

    @Test fun inboxFaLight() = inbox("inbox_fa_light", Language.FA, dark = false)
    @Test fun inboxEnDark() = inbox("inbox_en_dark", Language.EN, dark = true)
    @Test fun chatFaLight() = chat("chat_fa_light", Language.FA, dark = false)
    @Test fun chatEnDark() = chat("chat_en_dark", Language.EN, dark = true)

    @Test
    fun contactsFaLight() {
        val contacts = runBlocking { api.contacts("ws-1") }
        shot("contacts_fa_light", Language.FA, dark = false) {
            ContactsScreen(ContactsState.Loaded(contacts), Language.FA, onOpen = {})
        }
    }

    private fun settings(name: String, language: Language, dark: Boolean) {
        val account = runBlocking { api.account() }
        val workspaces = runBlocking { api.workspaces() }
        val availability = runBlocking { api.availability() }
        shot(name, language, dark) {
            SettingsScreen(
                language = language,
                appearance = Appearance.SYSTEM,
                account = AccountHeader(account.profile?.fullName ?: "", account.email, null),
                workspaces = workspaces,
                selectedWorkspace = workspaces.firstOrNull(),
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

    @Test fun settingsFaLight() = settings("settings_fa_light", Language.FA, dark = false)
    @Test fun settingsEnDark() = settings("settings_en_dark", Language.EN, dark = true)

    @Test
    fun contactDetailEnLight() {
        val contact = runBlocking { api.contacts("ws-1") }.first { it.id == "p-3" }
        shot("contact_detail_en_light", Language.EN, dark = false) {
            ContactDetailScreen(
                contact,
                Language.EN,
                profile = VisitorProfile(
                    geo = VisitorProfile.Geo(countryCode = "DE", city = "Berlin"),
                    device = VisitorProfile.Device(browser = "Safari", os = "macOS"),
                    lastSeenAt = Instant.parse("2025-03-02T09:12:00Z"),
                ),
            )
        }
    }

    @Test
    fun colleaguesFaDark() {
        val team = runBlocking { api.colleagues("ws-1") }.colleagues
        shot("colleagues_fa_dark", Language.FA, dark = true) {
            ColleaguesScreen(ColleaguesState.Loaded(team), Language.FA, onOpen = {})
        }
    }

    @Test
    fun emailInboxEnLight() {
        val threads = runBlocking { api.emailThreads("ws-1", null) }
        shot("email_inbox_en_light", Language.EN, dark = false) {
            EmailInboxScreen(EmailInboxState.Loaded(threads), Language.EN, onOpen = {})
        }
    }

    @Test
    fun profileFaLight() = shot("profile_fa_light", Language.FA, dark = false) {
        ProfileScreen(
            language = Language.FA,
            firstName = "Sara",
            lastName = "Karimi",
            email = "operator@webyar.app",
            phone = "+989121234567",
            avatarUrl = null,
            busy = false,
            error = null,
            onFirstNameChange = {},
            onLastNameChange = {},
            onPhoneChange = {},
            onPickAvatar = {},
            onRemoveAvatar = {},
            onSave = {},
        )
    }

    @Test
    fun securityEnDark() {
        val sessions = runBlocking { api.sessions() }
        shot("security_en_dark", Language.EN, dark = true) {
            SecurityScreen(
                language = Language.EN,
                currentPassword = "",
                newPassword = "",
                sessions = sessions.sessions,
                currentSessionId = sessions.currentSessionId,
                busy = false,
                message = null,
                isError = false,
                onCurrentPasswordChange = {},
                onNewPasswordChange = {},
                onChangePassword = {},
                onRevoke = {},
                onRevokeOthers = {},
            )
        }
    }

    @Test
    fun notificationsFaLight() {
        val prefs = runBlocking { api.notificationPrefs() }
        shot("notifications_fa_light", Language.FA, dark = false) {
            NotificationsScreen(
                language = Language.FA,
                state = NotificationsState(prefs = prefs, loading = false),
                systemPermission = null,
                onSet = { _, _ -> },
                onRetry = {},
            )
        }
    }

    /** The sign-in form on a tablet: a column in the middle, not fields a foot wide. */
    @Test
    @Config(qualifiers = RobolectricDeviceQualifiers.MediumTablet)
    fun loginTabletFaLight() = shot("login_tablet_fa_light", Language.FA, dark = false) {
        LoginScreen(Language.FA, onSubmit = { _, _ -> Result.success(Unit) })
    }

    @Test
    fun loginFaLight() = shot("login_fa_light", Language.FA, dark = false) {
        LoginScreen(Language.FA, onSubmit = { _, _ -> Result.success(Unit) })
    }

    @Test
    fun loginEnDark() = shot("login_en_dark", Language.EN, dark = true) {
        LoginScreen(Language.EN, onSubmit = { _, _ -> Result.success(Unit) })
    }
}
