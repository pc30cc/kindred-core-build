package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * A field and a send button, and nothing else.
 *
 * The chat's composer carries a paperclip, a microphone, saved replies and an
 * AI voice picker, all of which belong to a conversation with a visitor. An
 * email reply and anything else that is only words get this instead — the same
 * pill, the same send button, the same six-line cap, so the shape is familiar
 * without the controls that would do nothing here.
 */
@Composable
fun PlainComposer(
    draft: String,
    onDraftChange: (String) -> Unit,
    placeholder: String,
    sendLabel: String,
    sending: Boolean,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val canSend = draft.isNotBlank() && !sending

    Surface(
        color = MaterialTheme.colorScheme.surface,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(horizontal = Space.sm, vertical = Space.sm),
            verticalAlignment = Alignment.Bottom,
        ) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(Radius.xl),
                modifier = Modifier.weight(1f).padding(horizontal = Space.xs),
            ) {
                Box(Modifier.padding(horizontal = Space.md, vertical = Space.sm)) {
                    BasicTextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Sentences,
                            // Newline, not Send. A mail is paragraphs, and an
                            // operator who lost the first one to a stray
                            // Return does not write it again.
                            imeAction = ImeAction.Default,
                        ),
                        // Grows to six lines and then scrolls, like the chat's
                        // — a composer that grows without limit eats the trail
                        // it is a reply to.
                        maxLines = 6,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag(A11y.COMPOSER_FIELD),
                    )
                    if (draft.isEmpty()) {
                        Text(
                            placeholder,
                            style = MaterialTheme.typography.bodyLarge,
                            color = WebyarTheme.colors.labelTertiary,
                        )
                    }
                }
            }

            SendButton(
                enabled = canSend,
                label = sendLabel,
                onClick = onSend,
                sending = sending,
            )
        }
    }
}
