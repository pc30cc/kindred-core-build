package com.webyar.operator.core.storage

import androidx.datastore.preferences.core.stringPreferencesKey
import com.webyar.operator.i18n.Language

/**
 * The two choices that must survive a restart, and one that must not.
 *
 * Language and appearance are the operator's, so they are stored. The chosen
 * WORKSPACE is not: it is re-derived from what the server says the account
 * belongs to, because a workspace can be left, renamed or suspended between
 * launches and a remembered id would then point at nothing.
 */
class Preferences(private val store: SecureStore) {
    private val languageKey = stringPreferencesKey("prefs.language")
    private val appearanceKey = stringPreferencesKey("prefs.appearance")

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
