package com.webyar.operator.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import com.webyar.operator.i18n.Language

/**
 * The app's language as it is at the moment of asking — [AppState.language],
 * handed down by the activity.
 */
val LocalLanguageSource = staticCompositionLocalOf<(() -> Language)?> { null }

/**
 * What a view model takes as its language: read when a message is written,
 * not captured when the model is made.
 *
 * A model outlives the screen that made it — it stays while the screen is
 * under another on the stack — so `Model(api) { language }` kept the
 * language of the moment it was made, and after a switch to English every
 * later error in that screen still came in Persian. Outside the app (a
 * preview, a test composing one screen) the screen's own [language] stands in.
 */
@Composable
fun liveLanguage(language: Language): () -> Language {
    LocalLanguageSource.current?.let { return it }
    val current by rememberUpdatedState(language)
    return { current }
}
