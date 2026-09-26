package com.webyar.operator.feature.auth

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.graphics.shapes.RoundedPolygon
import com.webyar.operator.R
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.displayText
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.PrimaryButton
import com.webyar.operator.ui.components.ShapeFrame
import com.webyar.operator.ui.design.ExpressiveShapes
import com.webyar.operator.ui.design.PolygonShape
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarType
import kotlinx.coroutines.launch

/**
 * The way in.
 *
 * One deliberate choice worth naming: a failed sign-in says "invalid email or
 * password" in the operator's language rather than showing the server's own
 * sentence, and it says the SAME thing whether the address exists or not. The
 * endpoint answers identically either way so it cannot be used to discover
 * which addresses have accounts, and the UI must not undo that.
 *
 * The insets are `safeDrawing` and they go OUTSIDE the scroll, which is the
 * whole of the keyboard handling here. `enableEdgeToEdge` sets
 * `decorFitsSystemWindows = false`, and from that moment
 * `windowSoftInputMode="adjustResize"` resizes nothing: the window is told to
 * draw behind the keyboard and the app applies the inset itself. Outside the
 * scroll the viewport shortens, so a field the keyboard now covers can be
 * scrolled to — and Compose scrolls to it on focus without being asked.
 * Inside the scroll the padding would travel with the content and the field
 * would stay underneath.
 *
 * The look is Material 3 Expressive's: the brand mark in a scalloped shape,
 * two large soft shapes turning slowly behind the form, filled fields and a
 * pill button. The mark is the launcher's monochrome layer tinted with the
 * theme, so a white-label build and wallpaper colours both carry through
 * without a second asset. The form is capped at a readable width, so on a
 * tablet or an unfolded foldable it is a column in the middle rather than
 * fields a foot wide.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun LoginScreen(
    language: Language,
    onSubmit: suspend (String, String) -> Result<Unit>,
    modifier: Modifier = Modifier,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val emailFocus = remember { FocusRequester() }
    val passwordFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    // The keyboard comes up with the screen rather than waiting to be asked.
    // There is exactly one thing to do here and it needs typing, so making
    // somebody tap a field first is a tap that carries no information.
    LaunchedEffect(Unit) {
        emailFocus.requestFocus()
        keyboard?.show()
    }

    fun submit() {
        if (busy || email.isBlank() || password.isEmpty()) return
        keyboard?.hide()
        busy = true
        error = null
        scope.launch {
            onSubmit(email, password)
                .onFailure { error = it.displayText(language, unauthorized = Str.loginFailed(language)) }
            busy = false
        }
    }

    Box(
        modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface),
    ) {
        Backdrop()

        BoxWithConstraints(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing),
        ) {
            // The mark is a welcome, not a control: on a short window — a
            // phone in landscape, the keyboard up in split screen — it gives
            // its room to the fields.
            val roomy = maxHeight >= 560.dp

            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Space.xl, vertical = Space.xl),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Column(
                    Modifier
                        .widthIn(max = 440.dp)
                        .fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(Space.lg),
                ) {
                    if (roomy) {
                        BrandMark(size = 104.dp)
                        Spacer(Modifier.height(Space.sm))
                    }
                    Text(
                        Str.loginTitle(language),
                        style = WebyarType.displaySmallEmphasized,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        Str.loginSubtitle(language),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(Space.sm))

                    // `contentType` is what makes a password manager offer to
                    // fill this, and to offer to SAVE it afterwards. Without it
                    // the fields are two anonymous text boxes: Android has
                    // nothing to go on, so nothing is offered, and every
                    // sign-in is typed out by hand.
                    TextField(
                        value = email,
                        onValueChange = { email = it },
                        label = { Text(Str.emailLabel(language)) },
                        leadingIcon = { Icon(Icons.Outlined.Email, contentDescription = null) },
                        singleLine = true,
                        shape = FieldShape,
                        colors = fieldColors(),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Email,
                            imeAction = ImeAction.Next,
                        ),
                        // Next moves to the password rather than doing nothing,
                        // which is what an unhandled ImeAction does.
                        keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(emailFocus)
                            .semantics { contentType = ContentType.EmailAddress }
                            .testTag(A11y.LOGIN_EMAIL),
                    )

                    TextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text(Str.passwordLabel(language)) },
                        leadingIcon = { Icon(Icons.Outlined.Lock, contentDescription = null) },
                        singleLine = true,
                        shape = FieldShape,
                        colors = fieldColors(),
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Done,
                        ),
                        // Done signs in. Reaching for the button after typing a
                        // password is a trip back across the screen for no reason.
                        keyboardActions = KeyboardActions(onDone = { submit() }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(passwordFocus)
                            .semantics { contentType = ContentType.Password }
                            .testTag(A11y.LOGIN_PASSWORD),
                    )

                    AnimatedVisibility(
                        visible = error != null,
                        enter = fadeIn() + expandVertically(),
                        exit = fadeOut() + shrinkVertically(),
                    ) {
                        ErrorNote(error.orEmpty())
                    }

                    Spacer(Modifier.height(Space.xs))
                    PrimaryButton(
                        label = Str.logIn(language),
                        onClick = ::submit,
                        enabled = email.isNotBlank() && password.isNotEmpty(),
                        busy = busy,
                        modifier = Modifier.testTag(A11y.LOGIN_SUBMIT),
                    )
                }
            }
        }
    }
}

private val FieldShape = RoundedCornerShape(Radius.lg)

/**
 * Filled fields with no underline: the container is the field, the way the
 * Expressive text fields sit on a surface. The focused one gains a tint of
 * the brand, which is what tells the eye where the caret is.
 */
@Composable
private fun fieldColors() = TextFieldDefaults.colors(
    focusedContainerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    errorContainerColor = MaterialTheme.colorScheme.errorContainer,
    focusedIndicatorColor = Color.Transparent,
    unfocusedIndicatorColor = Color.Transparent,
    disabledIndicatorColor = Color.Transparent,
    errorIndicatorColor = Color.Transparent,
    focusedLeadingIconColor = MaterialTheme.colorScheme.primary,
)

/** The app's mark in a scalloped cookie — the brand, in the theme's colours. */
@Composable
private fun BrandMark(size: Dp) {
    ShapeFrame(
        polygon = ExpressiveShapes.cookie9,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.size(size),
    ) {
        // The monochrome layer is laid out for an adaptive icon's 108dp
        // canvas, with the mark inside its middle two thirds, so it fills the
        // frame and the padding comes with it.
        Image(
            painter = painterResource(R.mipmap.ic_launcher_monochrome),
            contentDescription = null,
            colorFilter = ColorFilter.tint(MaterialTheme.colorScheme.onPrimary),
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** A failed sign-in, as a tonal note rather than a line of red text. */
@Composable
private fun ErrorNote(text: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radius.lg))
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = Space.lg, vertical = Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(
            Icons.Outlined.Warning,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.size(20.dp),
        )
        Text(
            text = text,
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag(A11y.LOGIN_ERROR),
        )
    }
}

/**
 * Two large soft shapes, half off the edges, turning very slowly — enough
 * that the screen is not a blank sheet, not so much that it competes with the
 * form. With animations off they simply stand still.
 */
@Composable
private fun Backdrop() {
    val turn by rememberInfiniteTransition(label = "backdrop").animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(90_000, easing = LinearEasing)),
        label = "turn",
    )
    Box(Modifier.fillMaxSize()) {
        SoftShape(
            polygon = ExpressiveShapes.sunny,
            color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f),
            size = 320.dp,
            rotation = turn,
            modifier = Modifier.align(Alignment.TopEnd).offset(x = 120.dp, y = (-110).dp),
        )
        SoftShape(
            polygon = ExpressiveShapes.cookie4,
            color = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.45f),
            size = 220.dp,
            rotation = -turn,
            modifier = Modifier.align(Alignment.BottomStart).offset(x = (-90).dp, y = 70.dp),
        )
    }
}

@Composable
private fun SoftShape(polygon: RoundedPolygon, color: Color, size: Dp, rotation: Float, modifier: Modifier) {
    val shape = remember(polygon) { PolygonShape(polygon) }
    Box(
        modifier
            .size(size)
            .graphicsLayer { rotationZ = rotation }
            .clip(shape)
            .background(color),
    )
}
