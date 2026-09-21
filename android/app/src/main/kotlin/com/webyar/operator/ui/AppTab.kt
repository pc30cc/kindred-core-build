package com.webyar.operator.ui

/**
 * The shell's tabs.
 *
 * Only three, and that is deliberate rather than unfinished: colleagues and
 * email are reached from the inbox's own title menu, because they are other
 * inboxes rather than other places. A tab bar of five would say they are
 * equals, and an operator opens the visitor inbox a hundred times for every
 * time they open the mail one.
 *
 * Declared outside the shell because `AppState` remembers the selection, and
 * it remembers because a language change rebuilds the shell.
 */
enum class AppTab { INBOX, CONTACTS, SETTINGS }
