package com.webyar.operator.feature.contacts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.Contact
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface ContactsState {
    data object Loading : ContactsState
    data class Loaded(val contacts: List<Contact>) : ContactsState
    data class Failed(val message: String) : ContactsState
}

/**
 * Everyone the workspace has ever spoken to.
 *
 * Search is client-side here for the same reason as the inbox — the contacts
 * endpoint takes no query — but with one difference worth naming: this list is
 * not paged, so it is the whole address book rather than a page of it. On a
 * large workspace that is a big response, and the day it becomes a problem the
 * fix is a server parameter, not a cleverer filter here.
 */
class ContactsViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<ContactsState>(ContactsState.Loading)
    val state: StateFlow<ContactsState> = _state.asStateFlow()

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    private val _intel = MutableStateFlow<Map<String, VisitorProfile>>(emptyMap())
    val intel: StateFlow<Map<String, VisitorProfile>> = _intel.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private var workspaceId: String? = null
    private var loaded: List<Contact> = emptyList()

    fun bind(workspaceId: String) {
        if (this.workspaceId == workspaceId) return
        this.workspaceId = workspaceId
        _query.value = ""
        _intel.value = emptyMap()
        load()
    }

    fun setQuery(value: String) {
        _query.value = value
        publish()
    }

    fun refresh() {
        _refreshing.value = true
        load(showSkeleton = false)
    }

    fun retry() = load()

    private fun load(showSkeleton: Boolean = true) {
        val workspace = workspaceId ?: return
        if (showSkeleton) _state.value = ContactsState.Loading
        viewModelScope.launch {
            runCatching { api.contacts(workspace) }
                .onSuccess {
                    loaded = it
                    publish()
                    loadIntel(it)
                }
                .onFailure {
                    // A refresh that fails keeps the list it has; only a first
                    // load has nothing to fall back on.
                    if (showSkeleton || loaded.isEmpty()) {
                        _state.value = ContactsState.Failed(it.displayText(language()))
                    }
                }
            _refreshing.value = false
        }
    }

    /**
     * The device and country behind each contact.
     *
     * The same endpoint the inbox uses, keyed by contact rather than by
     * conversation — so a visitor cannot appear as an Android phone from
     * Türkiye on one screen and as bare initials on the next. Decorative: a
     * failure leaves the list rendering exactly as it is.
     */
    private fun loadIntel(contacts: List<Contact>) {
        val workspace = workspaceId ?: return
        val ids = contacts.map { it.id }
        if (ids.isEmpty()) return
        viewModelScope.launch {
            runCatching { api.visitorIntelByContact(workspace, ids) }
                .onSuccess { _intel.value = it }
        }
    }

    private fun publish() {
        val terms = _query.value.trim().lowercase()
        _state.value = ContactsState.Loaded(
            if (terms.isEmpty()) loaded else loaded.filter { it.matches(terms) }
        )
    }

    /** Name, address, number, code — every handle a contact can be found by. */
    private fun Contact.matches(needle: String): Boolean =
        listOfNotNull(name, email, phone, visitorCode)
            .any { it.lowercase().contains(needle) }

    /** The one already in hand, so the detail screen does not refetch a list. */
    fun contact(id: String): Contact? = loaded.firstOrNull { it.id == id }
}
