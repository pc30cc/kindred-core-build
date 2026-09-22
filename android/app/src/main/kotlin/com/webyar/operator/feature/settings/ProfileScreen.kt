package com.webyar.operator.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.PrimaryButton
import com.webyar.operator.ui.components.SecondaryButton
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space

/**
 * The operator's own name and face.
 *
 * A form rather than a list, because these two DO save together: the name and
 * the picture are one identity, and a half-applied change would leave the
 * inbox showing a new photograph beside an old name.
 */
@Composable
fun ProfileScreen(
    language: Language,
    firstName: String,
    lastName: String,
    email: String?,
    phone: String,
    avatarUrl: String?,
    busy: Boolean,
    error: String?,
    onFirstNameChange: (String) -> Unit,
    onLastNameChange: (String) -> Unit,
    onPhoneChange: (String) -> Unit,
    onPickAvatar: () -> Unit,
    onRemoveAvatar: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val name = listOf(firstName, lastName)
        .map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")
    Column(
        modifier
            .fillMaxWidth()
            // The keyboard only. The Scaffold above has already handed down
            // the system bars in `modifier`, and it does not include the IME
            // — its default `contentWindowInsets` is the bars alone. Outside
            // the scroll so the viewport shortens and the name field can be
            // scrolled clear of the keyboard rather than sitting under it.
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(Space.screenInset),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        Avatar(name = name, imageUrl = avatarUrl, size = Size.avatarLarge)

        Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            SecondaryButton(Str.changePhoto(language), onPickAvatar, enabled = !busy)
            if (avatarUrl != null) {
                SecondaryButton(Str.removePhoto(language), onRemoveAvatar, enabled = !busy)
            }
        }

        OutlinedTextField(
            value = firstName,
            onValueChange = onFirstNameChange,
            label = { Text(Str.firstName(language)) },
            singleLine = true,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = lastName,
            onValueChange = onLastNameChange,
            label = { Text(Str.lastName(language)) },
            singleLine = true,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        )

        if (email != null) {
            Column(Modifier.fillMaxWidth()) {
                Text(
                    Str.emailLabel(language),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // Read-only: changing the address is an identity change that
                // has to go through verification, and the console is where
                // that lives. Showing it greyed and unreachable is honest;
                // showing an editable field that 403s is not.
                LatinText(email, style = MaterialTheme.typography.bodyLarge)
            }
        }

        OutlinedTextField(
            value = phone,
            onValueChange = onPhoneChange,
            label = { Text(Str.phoneLabel(language)) },
            singleLine = true,
            enabled = !busy,
            // A number, and a Latin one wherever the interface language puts
            // its own digits: a phone number typed in Persian digits is not a
            // phone number anyone can dial.
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )

        if (error != null) {
            Text(
                error,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }

        PrimaryButton(
            Str.save(language),
            onSave,
            busy = busy,
            // A family name is optional; plenty of people have one name.
            enabled = firstName.isNotBlank(),
        )
    }
}
