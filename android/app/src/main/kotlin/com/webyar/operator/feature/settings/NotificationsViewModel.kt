package com.webyar.operator.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.NotificationPrefs
import com.webyar.operator.core.model.NotificationPrefsUpdate
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.ApiErrorText.displayText
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The state of the notifications screen.
 *
 * [prefs] is null only before the first answer arrives. After that it is
 * always the operator's real settings — including while a change is in
 * flight, because the switch moves the moment it is touched.
 */
data class NotificationsState(
    val prefs: NotificationPrefs? = null,
    val loading: Boolean = true,
    /** Non-null when the screen could not be read at all. */
    val loadError: String? = null,
    /** How many changes are on their way to the server. */
    val saving: Int = 0,
    /** Set when a change came back refused; cleared by the next success. */
    val saveError: String? = null,
) {
    val isSaving: Boolean get() = saving > 0
}

/**
 * Reads and writes one operator's notification preferences.
 *
 * There is no Save button, which is the console's choice too: a screen of
 * switches with a Save button is a screen people leave without saving. The
 * switch moves immediately and the request follows, and a request that fails
 * puts the switch back — which is the only honest thing to do with a control
 * that claims to have already taken effect.
 */
class NotificationsViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow(NotificationsState())
    val state: StateFlow<NotificationsState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        _state.update { it.copy(loading = true, loadError = null) }
        viewModelScope.launch {
            runCatching { api.notificationPrefs() }
                .onSuccess { prefs ->
                    _state.update { it.copy(prefs = prefs, loading = false, loadError = null) }
                }
                .onFailure { error ->
                    _state.update {
                        it.copy(
                            loading = false,
                            // A screen that cannot be read says so; a screen
                            // that could be read once keeps what it had.
                            loadError = if (it.prefs == null) {
                                error.displayText(language())
                            } else {
                                null
                            },
                        )
                    }
                }
        }
    }

    /**
     * Moves one switch and tells the server.
     *
     * [apply] is what the switch does to the local copy; [field] is the one
     * key to send. Both are given because they are genuinely different
     * things — the whole row cannot be sent back, or two phones editing two
     * different switches would each undo the other.
     */
    fun set(
        apply: (NotificationPrefs) -> NotificationPrefs,
        field: NotificationPrefsUpdate,
    ) {
        val before = _state.value.prefs ?: return
        val after = apply(before)
        if (after == before) return

        _state.update { it.copy(prefs = after, saving = it.saving + 1, saveError = null) }
        viewModelScope.launch {
            runCatching { api.updateNotificationPrefs(field) }
                .onSuccess { fresh ->
                    _state.update {
                        it.copy(
                            // The server's answer wins: it carries any field
                            // this build does not know about, and any value
                            // it decided to normalise.
                            prefs = fresh,
                            saving = (it.saving - 1).coerceAtLeast(0),
                            saveError = null,
                        )
                    }
                }
                .onFailure { error ->
                    _state.update { current ->
                        current.copy(
                            // Put it back. A switch left where the operator
                            // moved it, after the change was refused, is a
                            // lie the app tells every time they look at it.
                            //
                            // Only the fields this change touched go back: a
                            // second switch may have been answered while this
                            // one was in flight, and restoring the whole
                            // snapshot would silently undo it.
                            prefs = current.prefs?.let { revert(it, before, after) },
                            saving = (current.saving - 1).coerceAtLeast(0),
                            saveError = error.displayText(language()),
                        )
                    }
                }
        }
    }

    fun dismissSaveError() {
        _state.update { it.copy(saveError = null) }
    }

    private companion object {
        /**
         * `current` with every field that [attempted] changed put back to
         * [before]. Written field by field because a data class cannot be
         * merged generically without reflection, and reflection in a release
         * build is a proguard rule waiting to be forgotten.
         */
        fun revert(
            current: NotificationPrefs,
            before: NotificationPrefs,
            attempted: NotificationPrefs,
        ): NotificationPrefs = current.copy(
            disableAll = pick(current.disableAll, before.disableAll, attempted.disableAll),
            pushWhenOnline = pick(current.pushWhenOnline, before.pushWhenOnline, attempted.pushWhenOnline),
            pushWhenOffline = pick(current.pushWhenOffline, before.pushWhenOffline, attempted.pushWhenOffline),
            pushVisitorBrowsing = pick(current.pushVisitorBrowsing, before.pushVisitorBrowsing, attempted.pushVisitorBrowsing),
            playSound = pick(current.playSound, before.playSound, attempted.playSound),
            emailUnreadMessages = pick(current.emailUnreadMessages, before.emailUnreadMessages, attempted.emailUnreadMessages),
            emailTranscripts = pick(current.emailTranscripts, before.emailTranscripts, attempted.emailTranscripts),
            emailUserRatings = pick(current.emailUserRatings, before.emailUserRatings, attempted.emailUserRatings),
            emailPaidInvoices = pick(current.emailPaidInvoices, before.emailPaidInvoices, attempted.emailPaidInvoices),
            emailWeeklySummary = pick(current.emailWeeklySummary, before.emailWeeklySummary, attempted.emailWeeklySummary),
            emailProductUpdates = pick(current.emailProductUpdates, before.emailProductUpdates, attempted.emailProductUpdates),
            quietHoursEnabled = pick(current.quietHoursEnabled, before.quietHoursEnabled, attempted.quietHoursEnabled),
            quietHoursStart = pick(current.quietHoursStart, before.quietHoursStart, attempted.quietHoursStart),
            quietHoursEnd = pick(current.quietHoursEnd, before.quietHoursEnd, attempted.quietHoursEnd),
            quietHoursTimezone = pick(current.quietHoursTimezone, before.quietHoursTimezone, attempted.quietHoursTimezone),
        )

        /** [before] where this change touched the field, [current] otherwise. */
        fun <T> pick(current: T, before: T, attempted: T): T =
            if (before == attempted) current else before
    }
}
