package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * The state behind a search that a toolbar magnifier opens and closes.
 *
 * Three rules, all of them learned on iOS and all of them easy to get wrong:
 *
 * **The field is absent until it is asked for.** Parking it above the fold —
 * present in the list but scrolled out of sight — is what the iOS screen used
 * to do, and a row that is scrolled away is still *there*: it showed through
 * the translucent bar as a grey ghost, and tapping the magnifier a second time
 * did nothing, because scrolling to a row that is already on screen is a no-op.
 *
 * **Text outlives the toggle.** A field with something in it is still
 * filtering the list below, so hiding it would be a lie about why the list is
 * short. Only an empty field goes away.
 *
 * **A new question closes it.** Changing [resetOn] — a different queue, a
 * different workspace — clears the terms, because carrying them across would
 * silently filter a list the operator did not search.
 */
@Stable
class SearchState internal constructor(
    private val openState: MutableState<Boolean>,
    private val textState: MutableState<String>,
) {
    var isOpen: Boolean
        get() = openState.value
        private set(value) { openState.value = value }

    var text: String
        get() = textState.value
        set(value) { textState.value = value }

    /** Whether the field should be on screen: open, or holding live terms. */
    val isVisible: Boolean get() = isOpen || text.isNotEmpty()

    fun toggle() { if (isOpen) close() else isOpen = true }

    fun close() {
        isOpen = false
        text = ""
    }
}

@Composable
fun rememberSearchState(resetOn: Any? = Unit): SearchState {
    val open = rememberSaveable { mutableStateOf(false) }
    val text = rememberSaveable { mutableStateOf("") }
    val state = remember { SearchState(open, text) }
    LaunchedEffect(resetOn) { state.close() }
    return state
}

/**
 * The field itself — a pill inside the list, not a bar above it.
 *
 * Android's own pattern would be a `SearchBar`, which takes over the whole
 * screen with a full-screen results surface. That is right for a search that
 * IS the screen and wrong for one that filters a list in place, which is what
 * this is: the rows stay visible and narrow as you type.
 */
@Composable
fun SearchField(
    state: SearchState,
    prompt: String,
    modifier: Modifier = Modifier,
    clearLabel: String = "×",
) {
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    // The row has to exist before a caret can be put in it, so the request
    // waits for composition rather than racing it.
    LaunchedEffect(state.isOpen) {
        if (state.isOpen) {
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        shape = RoundedCornerShape(Radius.pill),
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Space.screenInset, vertical = Space.xs),
    ) {
        Row(
            Modifier
                .heightIn(min = Size.minTouchTarget)
                .padding(horizontal = Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.Search,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )

            Box(Modifier.weight(1f).padding(horizontal = Space.sm)) {
                BasicTextField(
                    value = state.text,
                    onValueChange = { state.text = it },
                    singleLine = true,
                    textStyle = LocalTextStyle.current.merge(
                        MaterialTheme.typography.bodyLarge.copy(
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    ),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester)
                        .testTag(A11y.SEARCH_FIELD),
                )
                if (state.text.isEmpty()) {
                    Text(
                        prompt,
                        style = MaterialTheme.typography.bodyLarge,
                        color = WebyarTheme.colors.labelTertiary,
                    )
                }
            }

            if (state.text.isNotEmpty()) {
                IconButton(onClick = { state.text = "" }, modifier = Modifier.size(32.dp)) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = clearLabel,
                        tint = WebyarTheme.colors.labelTertiary,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}
