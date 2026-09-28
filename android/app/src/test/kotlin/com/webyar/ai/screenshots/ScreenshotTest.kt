package com.webyar.ai.screenshots

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.storage.Appearance
import com.webyar.ai.feature.auth.LoginScreen
import com.webyar.ai.feature.chat.ChatScreen
import com.webyar.ai.feature.chat.ChatState
import com.webyar.ai.feature.contacts.ContactsScreen
import com.webyar.ai.feature.contacts.ContactsState
import com.webyar.ai.feature.inbox.InboxScreen
import com.webyar.ai.feature.inbox.InboxState
import com.webyar.ai.feature.settings.AccountHeader
import com.webyar.ai.feature.settings.AvailabilityState
import com.webyar.ai.feature.settings.SettingsScreen
import com.webyar.ai.feature.settings.NotificationsScreen
import com.webyar.ai.feature.settings.NotificationsState
import com.webyar.ai.feature.settings.ProfileScreen
import com.webyar.ai.feature.settings.SecurityScreen
import com.webyar.ai.feature.contacts.ContactDetailScreen
import com.webyar.ai.feature.team.ColleaguesScreen
import com.webyar.ai.feature.team.ColleaguesState
import com.webyar.ai.feature.email.EmailInboxScreen
import com.webyar.ai.feature.email.EmailInboxState
import com.webyar.ai.feature.analytics.AnalyticsRange
import com.webyar.ai.feature.analytics.AnalyticsReportScreen
import com.webyar.ai.feature.analytics.AnalyticsScreen
import com.webyar.ai.feature.analytics.AnalyticsSection
import com.webyar.ai.feature.analytics.AnalyticsState
import com.webyar.ai.feature.visitors.VisitorDetailScreen
import com.webyar.ai.feature.visitors.VisitorHistoryState
import com.webyar.ai.feature.visitors.VisitorText
import com.webyar.ai.feature.visitors.VisitorsScreen
import com.webyar.ai.feature.visitors.VisitorsState
import com.webyar.ai.core.model.VisitorProfile
import java.time.Instant
import com.webyar.ai.i18n.Language
import com.webyar.ai.ui.design.LocalReducedMotion
import com.webyar.ai.ui.design.WebyarTheme
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

    private fun visitors(name: String, language: Language, dark: Boolean) {
        val list = runBlocking { api.liveVisitors("ws-1", includeOffline = true) }
            .sortedByDescending { it.lastActivityAt }
        shot(name, language, dark) {
            VisitorsScreen(
                state = VisitorsState(visitors = list, loading = false),
                language = language,
                onOpen = {},
                onOpenPin = {},
                onRefresh = {},
                onOnlineOnly = {},
                onChatOnly = {},
                onCountry = {},
                onIncludeOffline = {},
                onClearFilters = {},
            )
        }
    }

    @Test fun visitorsFaLight() = visitors("visitors_fa_light", Language.FA, dark = false)
    @Test fun visitorsEnDark() = visitors("visitors_en_dark", Language.EN, dark = true)

    @Test
    fun visitorDetailFaLight() {
        val visitor = runBlocking { api.liveVisitors("ws-1", includeOffline = false) }.first()
        val history = runBlocking { api.visitorPageHistory("ws-1", visitor.id) }
        shot("visitor_detail_fa_light", Language.FA, dark = false) {
            VisitorDetailScreen(
                visitor = visitor,
                now = Instant.now(),
                history = VisitorHistoryState(visitor.id, VisitorText.steps(history, Language.FA), loading = false),
                chatBusy = false,
                language = Language.FA,
                onChat = {},
            )
        }
    }

    private fun analyticsState(): AnalyticsState {
        val (a, b) = AnalyticsRange.MONTH.bounds()
        val (pa, pb) = AnalyticsRange.MONTH.previousBounds()
        return AnalyticsState(
            overview = runBlocking { api.analyticsOverview("ws-1", a, b) },
            previous = runBlocking { api.analyticsOverview("ws-1", pa, pb) },
            breakdowns = mapOf("geo.country" to runBlocking { api.analyticsGeography("ws-1", "country", a, b) }),
            live = 3,
        )
    }

    @Test
    fun analyticsFaLight() = shot("analytics_fa_light", Language.FA, dark = false) {
        AnalyticsScreen(analyticsState(), Language.FA, selected = null, onOpen = {}, onRange = {}, onRefresh = {})
    }

    private fun report(name: String, section: AnalyticsSection, language: Language, dark: Boolean) {
        val state = analyticsState()
        shot(name, language, dark) {
            AnalyticsReportScreen(
                section = section,
                state = state,
                language = language,
                onRange = {},
                onSourceDimension = {},
                onPagesKind = {},
                onGeoDimension = {},
                onRetry = {},
            )
        }
    }

    @Test fun analyticsOverviewFaLight() = report("analytics_overview_fa_light", AnalyticsSection.OVERVIEW, Language.FA, dark = false)
    @Test fun analyticsOverviewEnDark() = report("analytics_overview_en_dark", AnalyticsSection.OVERVIEW, Language.EN, dark = true)
    @Test fun analyticsGeographyFaLight() = report("analytics_geography_fa_light", AnalyticsSection.GEOGRAPHY, Language.FA, dark = false)

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
            // As a phone sees it out of the box: Super Admin has not
            // unlocked the name or the number, so both are facts.
            nameEditable = false,
            phoneEditable = false,
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
