package com.webyar.operator.feature.promo

import android.content.Context
import android.content.SharedPreferences
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.BuildConfig
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.PromoCreative
import com.webyar.operator.core.model.Promotions
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Decides whether a promotion may be shown, and remembers that it was.
 *
 * Three things have to agree before a full-screen promotion appears:
 *
 *  * the plan grants it (`mobile_promo_fullscreen`),
 *  * the platform has one written and switched on,
 *  * and the pacing allows it — not during the first launches, not twice
 *    inside the interval, not more than the daily cap.
 *
 * The counters are per device and live in `SharedPreferences`. Nothing about
 * who saw what leaves the phone: there is no impression endpoint, and adding
 * one would turn a first-party promotion into tracking, with everything that
 * implies for Play's Data safety form.
 */
class PromotionCenter(
    private val api: WebyarApi,
    private val store: PromoCounters,
) : ViewModel() {

    private val _promotions = MutableStateFlow(Promotions.NONE)
    val promotions: StateFlow<Promotions> = _promotions.asStateFlow()

    /** Non-null while a full-screen promotion is on screen. */
    private val _fullscreen = MutableStateFlow<PromoCreative?>(null)
    val fullscreen: StateFlow<PromoCreative?> = _fullscreen.asStateFlow()

    /**
     * Cleared for the rest of the session once the operator closes the
     * banner, so closing it means something.
     */
    private val _bannerDismissed = MutableStateFlow(false)
    val bannerDismissed: StateFlow<Boolean> = _bannerDismissed.asStateFlow()

    fun load(workspaceId: String?, language: Language) {
        if (workspaceId == null || store.isSuppressed) return
        viewModelScope.launch {
            _promotions.value = runCatching { api.promotions(workspaceId, language.code) }
                .getOrDefault(Promotions.NONE)
        }
    }

    /** The banner, when the plan grants it and it has not been dismissed. */
    fun banner(entitlements: Entitlements?): PromoCreative? {
        if (!_promotions.value.enabled || _bannerDismissed.value) return null
        if (entitlements?.featureEnabled("mobile_promo_banner") != true) return null
        return _promotions.value.banner
    }

    fun dismissBanner() {
        _bannerDismissed.value = true
    }

    /**
     * Offers the full-screen promotion if everything lines up.
     *
     * Called when the inbox appears, never from a chat, a call or a compose
     * field. A promotion that interrupts work is the kind a store rejects and
     * an operator remembers.
     */
    fun offerFullScreen(entitlements: Entitlements?) {
        if (_fullscreen.value != null) return
        val promotions = _promotions.value
        if (!promotions.enabled) return
        if (entitlements?.featureEnabled("mobile_promo_fullscreen") != true) return
        val creative = promotions.fullscreen ?: return
        if (!isPaceClear(promotions, entitlements)) return

        _fullscreen.value = creative
        store.recordShown()
    }

    fun dismissFullScreen() {
        _fullscreen.value = null
    }

    // MARK: - Pacing

    private fun isPaceClear(promotions: Promotions, entitlements: Entitlements?): Boolean {
        if (store.launches <= (promotions.startAfterLaunches ?: DEFAULT_START_AFTER)) return false

        // The plan may ask for a LONGER gap than the platform's, never a
        // shorter one — a paid plan that still carries promotions should be
        // able to make them rarer, not more frequent.
        val platformMinutes = promotions.minIntervalMinutes ?: DEFAULT_INTERVAL_MINUTES
        val planMinutes = entitlements?.limit("mobile_promo_interval_minutes") ?: 0
        val minutes = maxOf(platformMinutes, planMinutes)
        store.lastShownAt?.let { last ->
            if (Instant.now().isBefore(last.plusSeconds(minutes * 60L))) return false
        }

        val cap = promotions.maxPerDay ?: DEFAULT_MAX_PER_DAY
        if (cap <= 0) return false
        return store.todayCount < cap
    }

    private companion object {
        const val DEFAULT_START_AFTER = 2
        const val DEFAULT_INTERVAL_MINUTES = 360
        const val DEFAULT_MAX_PER_DAY = 3
    }
}

/**
 * The per-device counters behind the pacing.
 *
 * Its own type rather than a `SharedPreferences` reached for inline, because
 * every one of these numbers is a rule the operator experiences — "not before
 * the third launch", "at most three a day" — and a test that cannot set them
 * is a test that cannot check any of it.
 */
class PromoCounters(private val prefs: SharedPreferences) {

    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    )

    /**
     * Counted once per launch, before anything is shown, so "skip the first
     * two launches" means the first two and not the first two that asked.
     *
     * Called from the Activity rather than from [PromotionCenter], because the
     * app counts launches and the center does not: the shell rebuilds its
     * center whenever the language changes, and a counter that reset with it
     * would let a promotion in on a first run.
     */
    fun noteLaunch() {
        prefs.edit().putInt(LAUNCHES, launches + 1).apply()
    }

    val launches: Int get() = prefs.getInt(LAUNCHES, 0)

    val lastShownAt: Instant?
        get() = prefs.getLong(LAST_SHOWN, 0L).takeIf { it > 0L }?.let(Instant::ofEpochMilli)

    /**
     * How many have been shown today — the DEVICE's today.
     *
     * A cap of three a day should mean the operator's day, not UTC's. An
     * operator in Tehran starting work at 08:00 is already four and a half
     * hours into a UTC day that would have spent their quota overnight.
     */
    val todayCount: Int
        get() = if (prefs.getString(DAY, null) == today()) prefs.getInt(DAY_COUNT, 0) else 0

    /** ISO-8601, so it sorts and compares as a string and needs no parser. */
    private fun today(): String = LocalDate.now(ZoneId.systemDefault()).toString()

    fun recordShown() {
        prefs.edit()
            .putLong(LAST_SHOWN, Instant.now().toEpochMilli())
            .putString(DAY, today())
            .putInt(DAY_COUNT, todayCount + 1)
            .apply()
    }

    /**
     * Whether this run was asked to serve no promotions at all.
     *
     * For the instrumentation tests, and it earns its place. A promotion is
     * paced — third launch onwards, at most three a day, six hours apart — so
     * whether the card appears depends on how many times the app has been
     * launched today. A suite that launches it fourteen times in a row gets a
     * card over the screen it just navigated to on some runs and not others,
     * and the failure reads as "the chat never opened". A thing that is
     * nondeterministic by design cannot be left in front of tests that are
     * not.
     *
     * Debug only, like every other launch flag here.
     */
    val isSuppressed: Boolean
        get() = BuildConfig.DEBUG && System.getProperty(SUPPRESS_FLAG) == "true"

    private companion object {
        const val FILE = "webyar.promotions"
        const val LAUNCHES = "promo.launches"
        const val LAST_SHOWN = "promo.lastShownAt"
        const val DAY = "promo.day"
        const val DAY_COUNT = "promo.dayCount"
        const val SUPPRESS_FLAG = "webyar.noPromotions"
    }
}
