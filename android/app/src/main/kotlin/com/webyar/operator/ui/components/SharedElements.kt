package com.webyar.operator.ui.components

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.window.core.layout.WindowSizeClass

/**
 * The scope shared-element transitions run in, for a screen that wants one —
 * the avatar that carries over from an inbox row to the chat it opens. Null
 * outside the shell (tests, previews), where a screen simply does without.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedTransitionScope = staticCompositionLocalOf<SharedTransitionScope?> { null }

/**
 * The enter/exit scope of the navigation entry a composable is in.
 *
 * Navigation 3's own `LocalNavAnimatedContentScope` throws when read outside
 * a `NavDisplay`, and the screens are composed outside one in every test.
 * The shell copies it in here for each entry; everywhere else it is null and
 * a shared element is simply not shared.
 */
val LocalEntryAnimatedScope = compositionLocalOf<AnimatedVisibilityScope?> { null }

/**
 * Marks this as the same element on two screens — the face in an inbox row
 * and the face in the chat it opens — so the move between them carries it
 * across instead of cutting.
 *
 * Only where one screen replaces the other. On a window wide enough for the
 * list and the chat side by side, both faces are on screen the whole time and
 * one flying into the other would be motion that means nothing.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedElement(key: Any): Modifier {
    val shared = LocalSharedTransitionScope.current ?: return this
    val scope = LocalEntryAnimatedScope.current ?: return this
    val wide = currentWindowAdaptiveInfo().windowSizeClass
        .isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND)
    if (wide) return this
    return with(shared) {
        this@sharedElement.sharedElement(
            sharedContentState = rememberSharedContentState(key),
            animatedVisibilityScope = scope,
        )
    }
}

/** The key an avatar is shared under, between the inbox and a chat. */
fun avatarKey(conversationId: String): String = "avatar:$conversationId"
