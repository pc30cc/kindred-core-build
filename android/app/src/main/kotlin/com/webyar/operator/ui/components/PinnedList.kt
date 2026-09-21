package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * A transcript that stays pinned to its newest message.
 *
 * The iOS counterpart is 216 lines, almost all of it keyboard machinery:
 * SwiftUI reports the keyboard as a bottom safe area, a safe area sits inside
 * the proposed size, and a `GeometryReader` never shrinks — so getting a
 * transcript to ride the keyboard up and back down takes observers, a
 * measured content height and a re-pin on a timer.
 *
 * Compose needs none of that. `Modifier.imePadding()` on the screen moves the
 * whole column, and a `LazyColumn` keeps its scroll offset across the change.
 * What is left is the one behaviour that is genuinely this component's: when a
 * message ARRIVES, come down to it — but only if the operator was already at
 * the bottom.
 *
 * That condition is the whole point. Scrolling a transcript back to read
 * something and being yanked to the end because the visitor typed is the most
 * annoying thing a chat app can do, and it is what a naive "scroll to last on
 * every change" produces.
 */
@Composable
fun PinnedLazyColumn(
    /** Anything that changes when a message is appended — a count, or the id
     *  of the newest row. */
    newestKey: Any?,
    modifier: Modifier = Modifier,
    state: LazyListState = rememberLazyListState(),
    contentPadding: PaddingValues = PaddingValues(),
    /** How close to the end still counts as "at the end", in items. */
    stickyWithin: Int = 2,
    content: LazyListScope.() -> Unit,
) {
    // Whether the operator is parked at the end right now.
    //
    // remember, not a plain local: a plain one is reassigned to true on every
    // recomposition, so the very first scroll away from the end would be
    // forgotten and the next message would yank the transcript back down —
    // the exact behaviour the rest of this file exists to avoid.
    //
    // Read from a snapshot flow rather than recomposed on, because the scroll
    // offset changes every frame during a fling and nothing here should run
    // every frame.
    var wasAtBottom by remember { mutableStateOf(true) }
    LaunchedEffect(state) {
        snapshotFlow {
            val layout = state.layoutInfo
            val last = layout.visibleItemsInfo.lastOrNull()?.index ?: return@snapshotFlow true
            last >= layout.totalItemsCount - 1 - stickyWithin
        }
            .distinctUntilChanged()
            .collect { wasAtBottom = it }
    }

    LaunchedEffect(newestKey) {
        if (!wasAtBottom) return@LaunchedEffect
        val target = state.layoutInfo.totalItemsCount - 1
        if (target >= 0) state.animateScrollToItem(target)
    }

    LazyColumn(
        modifier = modifier,
        state = state,
        contentPadding = contentPadding,
        content = content,
    )
}
