package com.webyar.operator.feature.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
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
 */
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

    fun submit() {
        if (busy || email.isBlank() || password.isEmpty()) return
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
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Text(Str.loginTitle(language), style = MaterialTheme.typography.headlineMedium)
        Text(Str.loginSubtitle(language), style = MaterialTheme.typography.bodyMedium)

        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text(Str.emailLabel(language)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Next,
            ),
            modifier = Modifier.fillMaxWidth().testTag(A11y.LOGIN_EMAIL),
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
            modifier = Modifier.fillMaxWidth().testTag(A11y.LOGIN_PASSWORD),
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
