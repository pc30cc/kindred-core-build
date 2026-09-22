package com.webyar.operator.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.AvailabilityPrefs
import com.webyar.operator.core.model.AvailabilityResponse
import com.webyar.operator.core.model.AvailabilityUpdate
import com.webyar.operator.core.net.WebyarApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What the availability section knows, and whether it is sure of it. */
sealed interface AvailabilityState {
    data object Loading : AvailabilityState
    data class Loaded(val response: AvailabilityResponse) : AvailabilityState
    data object Failed : AvailabilityState

    val prefs: AvailabilityPrefs? get() = (this as? Loaded)?.response?.prefs
    val isOnline: Boolean? get() = (this as? Loaded)?.response?.status?.isOnline
}

class SettingsViewModel(private val api: WebyarApi) : ViewModel() {

    private val _availability = MutableStateFlow<AvailabilityState>(AvailabilityState.Loading)
    val availability: StateFlow<AvailabilityState> = _availability.asStateFlow()

    /** Set when a save was refused, so the row can say so and then stop saying it. */
    private val _saveFailed = MutableStateFlow(false)
    val saveFailed: StateFlow<Boolean> = _saveFailed.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _availability.value = runCatching { api.availability() }
                .fold({ AvailabilityState.Loaded(it) }, { AvailabilityState.Failed })
        }
    }

    /**
     * Sends exactly the one field that changed.
     *
     * [AvailabilityUpdate] has three nullable fields and the server treats
     * null as "leave alone", so a toggle can never carry a stale copy of the
     * other two back — which is what would happen if the screen sent its whole
     * local view of the prefs each time and two devices were both open.
     */
    fun setForceOffline(value: Boolean) = patch(AvailabilityUpdate(forceOffline = value))
    fun setAvailableWhenUsingApp(value: Boolean) = patch(AvailabilityUpdate(availableWhenUsingApp = value))
    fun setScheduleEnabled(value: Boolean) = patch(AvailabilityUpdate(scheduleEnabled = value))

    fun dismissSaveFailure() {
        _saveFailed.value = false
    }

    private fun patch(update: AvailabilityUpdate) {
        viewModelScope.launch {
            runCatching { api.updateAvailability(update) }
                .onSuccess {
                    _availability.value = AvailabilityState.Loaded(it)
                    _saveFailed.value = false
                }
                // The switch stays where the server last said it was rather
                // than where the thumb left it: a toggle that looks saved and
                // is not is worse than one that visibly springs back.
                .onFailure { _saveFailed.value = true }
        }
    }
}
