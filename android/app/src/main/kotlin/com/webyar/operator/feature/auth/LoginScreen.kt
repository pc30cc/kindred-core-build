package com.webyar.operator.feature.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.displayText
import com.webyar.operator.ui.A11y
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

    Column(
        modifier = modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Text(Str.loginTitle(language), style = MaterialTheme.typography.headlineMedium)
        Text(Str.loginSubtitle(language), style = MaterialTheme.typography.bodyMedium)

        // `contentType` is what makes a password manager offer to fill this,
        // and to offer to SAVE it afterwards. Without it the fields are two
        // anonymous text boxes: Android has nothing to go on, so nothing is
        // offered, and every sign-in is typed out by hand.
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text(Str.emailLabel(language)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Next,
            ),
            // Next moves to the password rather than doing nothing, which is
            // what an unhandled ImeAction does.
            keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(emailFocus)
                .semantics { contentType = ContentType.EmailAddress }
                .testTag(A11y.LOGIN_EMAIL),
        )

        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(Str.passwordLabel(language)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
            ),
            // Done signs in. Reaching for the button after typing a password
            // is a trip back across the screen for no reason.
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(passwordFocus)
                .semantics { contentType = ContentType.Password }
                .testTag(A11y.LOGIN_PASSWORD),
        )

        error?.let {
            Text(
                text = it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag(A11y.LOGIN_ERROR),
            )
        }

        Button(
            onClick = ::submit,
            enabled = !busy && email.isNotBlank() && password.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().testTag(A11y.LOGIN_SUBMIT),
        ) {
            if (busy) CircularProgressIndicator(modifier = Modifier.padding(2.dp))
            else Text(Str.logIn(language))
        }
    }
}
