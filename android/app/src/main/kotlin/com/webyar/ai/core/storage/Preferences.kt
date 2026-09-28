package com.webyar.ai.core.storage

import androidx.datastore.preferences.core.stringPreferencesKey
import com.webyar.ai.core.model.MobileAppConfig
import com.webyar.ai.i18n.Language
import kotlinx.serialization.json.Json

/**
 * The choices that must survive a restart.
 *
 * Language and appearance are the operator's, so they are stored. So is the
 * workspace they were in — as a preference, never as the truth: it is kept
 * only while the server's list still has it (a workspace can be left,
 * renamed or suspended between launches), and only for the operator who
 * chose it. Without it, Android ending the app in the background put an
 * operator of two workspaces back in the first, under the screens they had
 * open in the second.
 */
class Preferences(private val store: SecureStore) {
    private val languageKey = stringPreferencesKey("prefs.language")
    private val appearanceKey = stringPreferencesKey("prefs.appearance")
    private val dynamicColorKey = stringPreferencesKey("prefs.dynamicColor")
    private val appConfigKey = stringPreferencesKey("prefs.appConfig")
    private val workspaceKey = stringPreferencesKey("prefs.workspace")
    private val pendingSignOutKey = stringPreferencesKey("session.pendingSignOut")
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Null when the operator has never chosen.
     *
     * Deliberately not defaulted here. The caller decides what "never chosen"
     * means, and on this product it does NOT mean "use the device language" —
     * the web app and the iOS app both keep a chosen language until it is
     * changed, and a Turkish operator on a Persian handset should not get a
     * different app from their colleague on an English one.
     */
    suspend fun language(): Language? = Language.from(store.read(languageKey))

    suspend fun setLanguage(language: Language) {
        store.write(languageKey, language.code)
    }

    suspend fun appearance(): Appearance =
        Appearance.from(store.read(appearanceKey)) ?: Appearance.SYSTEM

    suspend fun setAppearance(appearance: Appearance) {
        store.write(appearanceKey, appearance.key)
    }

    /**
     * Wallpaper colours (Material You) instead of the brand's.
     *
     * Off unless the operator turns it on: this is a white-label product and
     * the default palette is the customer's brand. Only offered where the
     * platform has it (Android 12 and later).
     */
    suspend fun dynamicColor(): Boolean = store.read(dynamicColorKey) == "on"

    suspend fun setDynamicColor(on: Boolean) {
        store.write(dynamicColorKey, if (on) "on" else "off")
    }

    /**
     * The last switches Super Admin sent ([MobileAppConfig]), so a launch
     * without a network keeps honouring them. Platform-wide, nothing about
     * the operator, so it outlives a sign-out. The defaults until one has
     * ever arrived, or if what is stored no longer reads.
     */
    suspend fun appConfig(): MobileAppConfig =
        store.read(appConfigKey)
            ?.let { runCatching { json.decodeFromString(MobileAppConfig.serializer(), it) }.getOrNull() }
            ?: MobileAppConfig.DEFAULT

    suspend fun setAppConfig(config: MobileAppConfig) {
        store.write(appConfigKey, json.encodeToString(MobileAppConfig.serializer(), config))
    }

    /** The workspace [accountId] was last in; null for anyone else. */
    suspend fun workspace(accountId: String): String? =
        store.read(workspaceKey)?.split('|', limit = 2)?.takeIf { it.size == 2 && it[0] == accountId }?.get(1)

    suspend fun setWorkspace(accountId: String, workspaceId: String?) {
        if (workspaceId == null) store.remove(workspaceKey) else store.write(workspaceKey, "$accountId|$workspaceId")
    }

    /**
     * A sign-out whose clean-up has not finished: the account it was for
     * (empty when unknown). Written before the clean-up starts and removed
     * when it is done, so the process ending half-way — the operator swiping
     * the app away on the login screen's way in — is finished at the next
     * launch rather than leaving their notifications and push token behind.
     */
    suspend fun pendingSignOut(): String? = store.read(pendingSignOutKey)

    suspend fun setPendingSignOut(accountId: String?) {
        if (accountId == null) store.remove(pendingSignOutKey) else store.write(pendingSignOutKey, accountId)
    }
}

/**
 * Light, dark, or whatever the phone is doing.
 *
 * SYSTEM is the default and the one most people keep. The other two exist
 * because an operator on a bright forecourt and an operator on a night shift
 * want opposite things, and neither wants to change a system setting to get
 * it.
 */
enum class Appearance(val key: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark");

    companion object {
        fun from(key: String?): Appearance? = entries.firstOrNull { it.key == key }
    }
}
