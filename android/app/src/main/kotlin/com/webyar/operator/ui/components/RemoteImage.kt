package com.webyar.operator.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import coil3.compose.SubcomposeAsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade

/**
 * A picture from the network, with a skeleton while it comes and a caller's
 * fallback if it never does.
 *
 * The iOS original is 236 lines because it had to build its own cache,
 * in-flight de-duplication and cancellation. Coil has all three, so this is
 * mostly a statement of what the three states should look like.
 *
 * The one rule worth keeping from that file: **a fallback is not a loading
 * state.** Drawing initials while a photograph loads means every face in a
 * scrolling list shows a letter and then swaps it for a picture, which reads
 * as the row changing its mind. A skeleton says "something is coming" and is
 * replaced by the thing that came.
 */
@Composable
fun RemoteImage(
    url: String?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
    fallback: @Composable () -> Unit,
) {
    // No URL is not a failure and has no loading state: it is simply the case
    // where the fallback IS the answer, so nothing is asked of the network.
    if (url.isNullOrBlank()) {
        Box(modifier) { fallback() }
        return
    }

    SubcomposeAsyncImage(
        model = ImageRequest.Builder(LocalContext.current)
            .data(url)
            // Short, because these are faces in a list and a long fade reads
            // as lag rather than as polish.
            .crossfade(160)
            .build(),
        contentDescription = contentDescription,
        modifier = modifier,
        contentScale = contentScale,
        loading = { Skeleton(Modifier.fillMaxSize()) },
        error = { fallback() },
    )
}

/**
 * The shimmer.
 *
 * Deliberately low-contrast: this appears dozens at a time in a scrolling
 * inbox, and a bright sweep across every row is the kind of motion that makes
 * a list feel busy rather than fast.
 */
@Composable
private fun Skeleton(modifier: Modifier = Modifier) {
    val shimmer by rememberLoop(
        label = "skeleton-alpha",
        from = 0.45f,
        to = 0.85f,
        spec = infiniteRepeatable(
            animation = tween(820),
            repeatMode = RepeatMode.Reverse,
        ),
        rest = 0.65f,
    )
    Box(
        modifier
            .graphicsLayer { alpha = shimmer }
            .background(MaterialTheme.colorScheme.surfaceContainerHighest)
    )
}
