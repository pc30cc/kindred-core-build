package com.webyar.operator.ui.components

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.VisualTransformation
import com.webyar.operator.ui.design.Radius
import androidx.compose.material3.LocalTextStyle
import androidx.compose.ui.text.style.TextDirection

/**
 * The app's text field: filled, rounded, and without an underline.
 *
 * The container is the field, the way Expressive's fields sit on a surface;
 * the focused one takes a tint of the brand, which is what tells the eye
 * where the caret is. One definition, so the sign-in form, the profile and
 * the password change are visibly the same kind of field.
 */
@Composable
fun FilledField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    isError: Boolean = false,
    leadingIcon: (@Composable () -> Unit)? = null,
    trailingIcon: (@Composable () -> Unit)? = null,
    supportingText: String? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    /**
     * Lay the value out left to right whatever the interface is doing — a
     * phone number, whose leading `+` is not a strong character, would
     * otherwise land at the far end in Persian: «989121234567+».
     */
    ltr: Boolean = false,
) {
    TextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        enabled = enabled,
        singleLine = singleLine,
        maxLines = maxLines,
        isError = isError,
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
        supportingText = supportingText?.let { { Text(it) } },
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        visualTransformation = visualTransformation,
        textStyle = if (ltr) {
            LocalTextStyle.current.copy(textDirection = TextDirection.Ltr)
        } else {
            LocalTextStyle.current
        },
        shape = FieldShape,
        colors = filledFieldColors(),
        modifier = modifier,
    )
}

private val FieldShape = RoundedCornerShape(Radius.lg)

@Composable
fun filledFieldColors(): TextFieldColors = TextFieldDefaults.colors(
    focusedContainerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
    // Highest, a step above the group cards a field often sits in, so it
    // reads as a field in dark mode and not as more card.
    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
    disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.6f),
    errorContainerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.6f),
    focusedIndicatorColor = Color.Transparent,
    unfocusedIndicatorColor = Color.Transparent,
    disabledIndicatorColor = Color.Transparent,
    errorIndicatorColor = Color.Transparent,
    focusedLeadingIconColor = MaterialTheme.colorScheme.primary,
)
