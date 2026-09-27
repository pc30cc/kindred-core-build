package com.webyar.operator.ui

/**
 * The shell's tabs, in the bar's order.
 *
 * Colleagues and email are reached from the inbox's own title menu, because
 * they are other inboxes rather than other places. Visitors and Website
 * analytics are places of their own, as in the Mac app's sidebar — each shown
 * only when the plan carries it and Super Admin has not switched it off for
 * the Android app ([AppState.tabs]), so most bars are three or four long and
 * none is more than five.
 *
 * Declared outside the shell because `AppState` remembers the selection, and
 * it remembers because a language change rebuilds the shell.
 */
enum class AppTab { INBOX, CONTACTS, VISITORS, ANALYTICS, SETTINGS }
