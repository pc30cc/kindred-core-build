package com.webyar.operator.core

import android.util.Log

/**
 * What the sync, realtime, push and cache layers say about themselves.
 *
 * `adb logcat -s Webyar.Sync Webyar.Realtime Webyar.Push Webyar.Cache
 * Webyar.Media` reads the whole story of a session: cache hits at launch,
 * delta sizes, why a reconcile ran, when the socket came and went, when
 * polling took over, which token was registered (never the token itself).
 *
 * The rule for every call site: counts, reasons, durations and truncated ids.
 * Never a message body, a name, an address, a push payload, a token or a
 * byte of an attachment — logcat is readable by anyone holding the phone
 * over adb, and on older releases by apps with READ_LOGS.
 */
interface Diag {
    fun info(area: String, message: String)
    fun warn(area: String, message: String)

    /** Logcat, in every build: these lines are what a field report is diagnosed from. */
    object Android : Diag {
        override fun info(area: String, message: String) {
            runCatching { Log.i("Webyar.$area", message) }
        }

        override fun warn(area: String, message: String) {
            runCatching { Log.w("Webyar.$area", message) }
        }
    }

    object Silent : Diag {
        override fun info(area: String, message: String) {}
        override fun warn(area: String, message: String) {}
    }

    /** For tests that assert on what was (and was not) logged. */
    class Recording : Diag {
        private val _lines = mutableListOf<String>()
        val lines: List<String> get() = synchronized(_lines) { _lines.toList() }

        override fun info(area: String, message: String) {
            synchronized(_lines) { _lines += "I/$area: $message" }
        }

        override fun warn(area: String, message: String) {
            synchronized(_lines) { _lines += "W/$area: $message" }
        }
    }

    companion object {
        /** An id shortened to something that tells two apart and names nobody. */
        fun id(value: String?): String = value?.take(8) ?: "-"
    }
}
