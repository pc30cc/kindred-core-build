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
    val name: String = "",
    val email: String? = null,
    val avatarUrl: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val loaded: Boolean = false,
)

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
                    it.copy(
                        name = if (it.loaded) it.name else account.profile?.fullName.orEmpty(),
                        email = account.email,
                        avatarUrl = account.profile?.avatarUrl,
                        loaded = true,
                    )
                }
            }
        }
    }

    fun setName(value: String) {
        _profile.update { it.copy(name = value, error = null) }
    }

    fun saveProfile(onDone: () -> Unit = {}) {
        val name = _profile.value.name.trim()
        if (name.isEmpty()) return
        _profile.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { api.updateProfile(fullName = name, preferredLocale = null) }
                .onSuccess { account ->
                    _profile.update {
                        it.copy(
                            busy = false,
                            name = account.profile?.fullName ?: name,
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
