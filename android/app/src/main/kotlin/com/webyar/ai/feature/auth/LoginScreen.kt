package com.webyar.ai.feature.auth

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.infiniteRepeatable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Email
import androidx.compose.material3.IconButton
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
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
import com.webyar.ai.R
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.i18n.StrManual
import com.webyar.ai.i18n.displayText
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.BrandFooterClearance
import com.webyar.ai.ui.components.BrandFooterOverlay
import com.webyar.ai.ui.components.PrimaryButton
import com.webyar.ai.ui.components.filledFieldColors
import com.webyar.ai.ui.components.ShapeFrame
import com.webyar.ai.ui.design.ExpressiveShapes
import com.webyar.ai.ui.design.PolygonShape
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarType
import kotlinx.coroutines.launch
import com.webyar.ai.ui.components.rememberLoop

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
    /**
     * Asks the server to email a reset link (`WebyarApi.requestPasswordReset`).
     * Null leaves "Forgot password?" off the screen — nothing to offer
     * without somewhere to send the request.
     */
    onRequestReset: (suspend (String) -> Result<Unit>)? = null,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var resetting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val emailFocus = remember { FocusRequester() }
    val passwordFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    fun submit() {
        if (busy || email.isBlank() || password.isEmpty()) return
        keyboard?.hide()
        busy = true
        error = null
        scope.launch {
            onSubmit(email, password)
                .onFailure { error = loginErrorText(it, language) }
            busy = false
        }
    }

    if (resetting && onRequestReset != null) {
        ResetPasswordScreen(
            language = language,
            initialEmail = email,
            onRequest = onRequestReset,
            // The address typed there is the one to sign in with next.
            onBack = { typed ->
                email = typed
                error = null
                resetting = false
            },
            modifier = modifier,
        )
        return
    }

    Box(
        modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface),
    ) {
        Backdrop()
        // iOS's signature at the foot: the same spot as on the loading
        // screen before this one and the reset screen after it.
        BrandFooterOverlay()

        BoxWithConstraints(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing),
        ) {
            // The mark is a welcome, not a control: on a short window — a
            // phone in landscape, the keyboard up in split screen — it gives
            // its room to the fields.
            val roomy = maxHeight >= 560.dp

            // The keyboard comes up with the screen rather than waiting to be
            // asked. There is exactly one thing to do here and it needs
            // typing, so making somebody tap a field first is a tap that
            // carries no information. Requested from in here, not from the
            // top of the screen: this is a subcomposition, and an effect up
            // there runs before the fields down here exist to take focus.
            LaunchedEffect(Unit) {
                emailFocus.requestFocus()
                keyboard?.show()
            }

            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    // Room at the end for the name signed at the foot, so on a
                    // short screen the form stops above it rather than under it.
                    .padding(start = Space.xl, end = Space.xl, top = Space.xl, bottom = BrandFooterClearance),
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
                        shape = RoundedCornerShape(Radius.lg),
                        colors = filledFieldColors(),
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
                        shape = RoundedCornerShape(Radius.lg),
                        colors = filledFieldColors(),
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
                    if (onRequestReset != null) {
                        TextButton(
                            onClick = { resetting = true },
                            enabled = !busy,
                            modifier = Modifier.align(Alignment.CenterHorizontally),
                        ) { Text(Str.forgotPassword(language)) }
                    }
                }
            }
        }
    }
}

/**
 * What a refused sign-in says.
 *
 * Mostly the one sentence for every refusal, for the reason in the class
 * comment. Two refusals are not about the password at all, and saying
 * "check your email and password" over them sent people round in circles:
 * an account that has never had a password (migrated, or invited and never
 * finished) is told how to choose one, and a sign-in the server will only
 * take with a captcha — which this app cannot show — is told to wait or use
 * the web. The server answers both before it looks at the password.
 */
internal fun loginErrorText(error: Throwable, language: Language): String {
    val server = error as? ApiError.Server
    val message = server?.serverMessage.orEmpty()
    return when {
        server?.status == 403 && message.contains("password setup", ignoreCase = true) ->
            StrAndroid.passwordSetupRequired(language)
        server?.status == 400 && message.contains("captcha", ignoreCase = true) ->
            StrAndroid.captchaRequired(language)
        else -> error.displayText(language, unauthorized = Str.loginFailed(language))
    }
}

/**
 * "Forgot password?": an address, a link sent to it, and the way back.
 *
 * The confirmation reads the same whether or not the address has an
 * account — the endpoint answers identically either way, so it cannot be
 * used to find out who has one, and saying "no such account" here would
 * undo that. Also the way in for an account that has never had a password:
 * the same link chooses the first one.
 */
@Composable
private fun ResetPasswordScreen(
    language: Language,
    initialEmail: String,
    onRequest: suspend (String) -> Result<Unit>,
    onBack: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var email by remember { mutableStateOf(initialEmail) }
    var sentTo by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    BackHandler { onBack(email) }

    fun send() {
        val address = email.trim()
        if (busy || address.isEmpty()) return
        keyboard?.hide()
        busy = true
        error = null
        scope.launch {
            onRequest(address)
                .onSuccess { sentTo = address }
                .onFailure { error = it.displayText(language) }
            busy = false
        }
    }

    Box(
        modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface),
    ) {
        Backdrop()
        BrandFooterOverlay()

        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing),
        ) {
            // The way back where iOS's navigation bar puts it: a screen pushed
            // from sign in, not a second form under it.
            IconButton(
                onClick = { onBack(email) },
                modifier = Modifier
                    .padding(start = Space.xs, top = Space.xs)
                    .testTag(A11y.RESET_BACK),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = StrAndroid.back(language))
            }

            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(start = Space.xl, end = Space.xl, top = Space.sm, bottom = BrandFooterClearance),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Column(
                    Modifier
                        .widthIn(max = 440.dp)
                        .fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    val sent = sentTo
                    if (sent != null) {
                        ResetGlyph(Icons.Filled.Email)
                        ResetHeading(Str.resetSentTitle(language))
                        ResetCaption(StrManual.resetSentDetail(language, sent))
                        Text(
                            Str.resetCheckSpam(language),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(top = Space.sm).widthIn(max = 320.dp),
                        )
                        Spacer(Modifier.height(Space.xl))
                        PrimaryButton(
                            label = Str.backToLogin(language),
                            onClick = { onBack(email) },
                        )
                    } else {
                        LaunchedEffect(Unit) {
                            // Straight into the field when there is nothing in
                            // it: the whole screen is one question.
                            if (email.isBlank()) {
                                focus.requestFocus()
                                keyboard?.show()
                            }
                        }
                        ResetGlyph(KeyGlyph)
                        ResetHeading(Str.resetTitle(language))
                        ResetCaption(Str.resetSubtitle(language))
                        Spacer(Modifier.height(Space.xxl))
                        TextField(
                            value = email,
                            onValueChange = {
                                email = it
                                error = null
                            },
                            label = { Text(Str.emailLabel(language)) },
                            leadingIcon = { Icon(Icons.Outlined.Email, contentDescription = null) },
                            singleLine = true,
                            enabled = !busy,
                            shape = RoundedCornerShape(Radius.lg),
                            colors = filledFieldColors(),
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Email,
                                imeAction = ImeAction.Send,
                            ),
                            keyboardActions = KeyboardActions(onSend = { send() }),
                            modifier = Modifier
                                .fillMaxWidth()
                                .focusRequester(focus)
                                .semantics { contentType = ContentType.EmailAddress },
                        )
                        AnimatedVisibility(
                            visible = error != null,
                            enter = fadeIn() + expandVertically(),
                            exit = fadeOut() + shrinkVertically(),
                        ) {
                            Box(Modifier.padding(top = Space.md)) { ErrorNote(error.orEmpty()) }
                        }
                        Spacer(Modifier.height(Space.xl))
                        PrimaryButton(
                            label = Str.sendResetLink(language),
                            onClick = ::send,
                            enabled = email.isNotBlank(),
                            busy = busy,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The one piece of ornament on either state: the subject of the screen, in a
 * soft brand disc — iOS's `glyph`. It is what stops a screen holding one
 * field from looking like an error page.
 */
@Composable
private fun ResetGlyph(icon: ImageVector) {
    Box(
        Modifier
            .padding(bottom = Space.md)
            .size(64.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
    }
}

@Composable
private fun ResetHeading(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        color = MaterialTheme.colorScheme.onSurface,
        textAlign = TextAlign.Center,
    )
}

/**
 * Under the heading, as a caption: capped at 320dp, so a two-line
 * explanation under a one-line title does not stretch across a wide screen
 * and read as a paragraph.
 */
@Composable
private fun ResetCaption(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
        modifier = Modifier.padding(top = Space.sm).widthIn(max = 320.dp),
    )
}

/**
 * A key, for "reset your password" — iOS draws `key.horizontal.fill` there.
 * Material's `VpnKey` outline (Apache 2.0); the core icon set this app uses
 * has no key, and the extended set is far too large to take for one glyph.
 */
private val KeyGlyph: ImageVector by lazy {
    ImageVector.Builder(name = "Key", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
        .addPath(
            pathData = PathParser().parsePathString(
                "M12.65,10C11.83,7.67 9.61,6 7,6c-3.31,0 -6,2.69 -6,6s2.69,6 6,6c2.61,0 4.83,-1.67 5.65,-4H17v4h4v-4h2v-4H12.65z" +
                    "M7,14c-1.1,0 -2,-0.9 -2,-2s0.9,-2 2,-2 2,0.9 2,2 -0.9,2 -2,2z",
            ).toNodes(),
            fill = SolidColor(Color.Black),
        )
        .build()
}

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
    val turn by rememberLoop(
        label = "backdrop.turn",
        from = 0f,
        to = 360f,
        spec = infiniteRepeatable(tween(90_000, easing = LinearEasing)),
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
