package com.webyar.operator.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.AccountSession
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The profile form, as the screen holds it. */
data class ProfileForm(
    val firstName: String = "",
    val lastName: String = "",
    val email: String? = null,
    val phone: String = "",
    val avatarUrl: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val loaded: Boolean = false,
    /**
     * Somebody has edited this form.
     *
     * `loaded` used to stand in for this, and with one field it very nearly
     * worked. With three it does not: typing a first name and letting a
     * refresh land filled the family name in from the server underneath the
     * cursor, because only the field being typed was guarded.
     */
    val touched: Boolean = false,
) {
    /** What the avatar and the rest of the app call this person. */
    val name: String
        get() = listOf(firstName, lastName)
            .map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")
}

/**
 * The stored name is one string; the screen asks for two.
 *
 * The server composes `full_name` from the parts it is given and hands back
 * only the composed result, so the split has to happen here. The last space
 * is the seam: "مجتبی داودی" and "Ada Lovelace" both split the way a person
 * would expect, and a single word is a first name with no family name yet
 * rather than a family name with no first.
 */
internal fun splitFullName(full: String?): Pair<String, String> {
    val trimmed = full?.trim().orEmpty()
    if (trimmed.isEmpty()) return "" to ""
    val cut = trimmed.lastIndexOf(' ')
    if (cut <= 0) return trimmed to ""
    return trimmed.substring(0, cut).trim() to trimmed.substring(cut + 1).trim()
}

/** The security screen's two halves. */
data class SecurityForm(
    val currentPassword: String = "",
    val newPassword: String = "",
    val sessions: List<AccountSession> = emptyList(),
    val currentSessionId: String? = null,
    val busy: Boolean = false,
    val message: String? = null,
    val isError: Boolean = false,
)

/**
 * The account screens' state.
 *
 * One view model for both because they read the same `/api/account/me` and a
 * password change invalidates the session list — two view models would have to
 * tell each other that, and the telling is the bug.
 */
class AccountViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _profile = MutableStateFlow(ProfileForm())
    val profile: StateFlow<ProfileForm> = _profile.asStateFlow()

    private val _security = MutableStateFlow(SecurityForm())
    val security: StateFlow<SecurityForm> = _security.asStateFlow()

    init {
        loadProfile()
        loadSessions()
    }

    // MARK: - Profile

    fun loadProfile() {
        viewModelScope.launch {
            runCatching { api.account() }.onSuccess { account ->
                _profile.update {
                    // Only seed the field if the operator has not started
                    // typing: re-reading the account after a save must not
                    // overwrite a name they are halfway through changing.
                    val (first, last) = splitFullName(account.profile?.fullName)
                    it.copy(
                        firstName = if (it.touched) it.firstName else first,
                        lastName = if (it.touched) it.lastName else last,
                        email = account.email,
                        phone = if (it.touched) it.phone else account.phone.orEmpty(),
                        avatarUrl = account.profile?.avatarUrl,
                        loaded = true,
                    )
                }
            }
        }
    }

    fun setFirstName(value: String) {
        _profile.update { it.copy(firstName = value, error = null, touched = true) }
    }

    fun setLastName(value: String) {
        _profile.update { it.copy(lastName = value, error = null, touched = true) }
    }

    fun setPhone(value: String) {
        _profile.update { it.copy(phone = value, error = null, touched = true) }
    }

    fun saveProfile(onDone: () -> Unit = {}) {
        val form = _profile.value
        val first = form.firstName.trim()
        val last = form.lastName.trim()
        // A family name is optional — plenty of people have one name — but a
        // first name is what everything else in the app labels them by.
        if (first.isEmpty()) return
        _profile.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                api.updateProfile(
                    firstName = first,
                    lastName = last,
                    // Empty rather than null: the route reads `phone || null`,
                    // and a null would be dropped from the body entirely and
                    // leave the old number standing.
                    phone = form.phone.trim(),
                )
            }
                .onSuccess { account ->
                    val (storedFirst, storedLast) = splitFullName(account.profile?.fullName)
                    _profile.update {
                        it.copy(
                            busy = false,
                            firstName = storedFirst.ifEmpty { first },
                            lastName = if (storedFirst.isEmpty()) last else storedLast,
                            phone = account.phone.orEmpty(),
                            avatarUrl = account.profile?.avatarUrl,
                        )
                    }
                    onDone()
                }
                .onFailure { error ->
                    _profile.update { it.copy(busy = false, error = error.displayText(language())) }
                }
        }
    }

    fun uploadAvatar(bytes: ByteArray, contentType: String, fileName: String?) {
        if (bytes.size > MAX_AVATAR_BYTES) {
            _profile.update { it.copy(error = Str.photoTooLarge(language())) }
            return
        }
        _profile.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { api.uploadAvatar(bytes, contentType, fileName) }
                .onSuccess { uploaded ->
                    _profile.update { it.copy(busy = false, avatarUrl = uploaded?.avatarUrl) }
                }
                .onFailure { error ->
                    _profile.update { it.copy(busy = false, error = error.displayText(language())) }
                }
        }
    }

    fun removeAvatar() {
        _profile.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { api.deleteAvatar() }
                .onSuccess { _profile.update { it.copy(busy = false, avatarUrl = null) } }
                .onFailure { error ->
                    _profile.update { it.copy(busy = false, error = error.displayText(language())) }
                }
        }
    }

    // MARK: - Security

    fun loadSessions() {
        viewModelScope.launch {
            runCatching { api.sessions() }.onSuccess { response ->
                _security.update {
                    it.copy(
                        sessions = response.sessions,
                        currentSessionId = response.currentSessionId,
                    )
                }
            }
        }
    }

    fun setCurrentPassword(value: String) {
        _security.update { it.copy(currentPassword = value, message = null) }
    }

    fun setNewPassword(value: String) {
        _security.update { it.copy(newPassword = value, message = null) }
    }

    fun changePassword() {
        val form = _security.value
        _security.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            runCatching { api.changePassword(form.currentPassword, form.newPassword) }
                .onSuccess {
                    _security.update {
                        it.copy(
                            busy = false,
                            // Cleared, not kept: a password left in a field is
                            // a password on screen, and this screen is the one
                            // people open when they are worried about exactly
                            // that.
                            currentPassword = "",
                            newPassword = "",
                            message = Str.passwordChanged(language()),
                            isError = false,
                        )
                    }
                    // A password change ends other sessions server-side, so the
                    // list on screen is now wrong.
                    loadSessions()
                }
                .onFailure { error ->
                    _security.update {
                        it.copy(busy = false, message = error.displayText(language()), isError = true)
                    }
                }
        }
    }

    fun revoke(session: AccountSession) {
        viewModelScope.launch {
            runCatching { api.revokeSession(session.id) }
                .onSuccess { loadSessions() }
                .onFailure { error ->
                    _security.update {
                        it.copy(message = error.displayText(language()), isError = true)
                    }
                }
        }
    }

    /**
     * Ends every session but this one.
     *
     * The list this sits under is honest — the server already returns only
     * sessions that are neither revoked nor expired — but honest is not the
     * same as short: every sign-in makes one, and a mobile session is
     * long-lived on purpose, so an operator who has signed in from a few
     * phones over a few months is looking at a page of their own devices
     * with no idea which are still theirs. One button is the answer.
     */
    fun revokeOthers() {
        viewModelScope.launch {
            _security.update { it.copy(busy = true, message = null, isError = false) }
            runCatching { api.revokeOtherSessions() }
                .onSuccess {
                    _security.update { it.copy(busy = false) }
                    loadSessions()
                }
                .onFailure { error ->
                    _security.update {
                        it.copy(busy = false, message = error.displayText(language()), isError = true)
                    }
                }
        }
    }

    private companion object {
        /**
         * The server's own avatar cap.
         *
         * Checked here so a phone on a slow connection is not asked to upload
         * four megabytes before being told no — which on a metered connection
         * is somebody's money.
         */
        const val MAX_AVATAR_BYTES = 2 * 1024 * 1024
    }
}
