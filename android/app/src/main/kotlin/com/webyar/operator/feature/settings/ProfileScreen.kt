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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.PrimaryButton
import com.webyar.operator.ui.design.Space
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.components.DetailRow
import com.webyar.operator.ui.components.FilledField
import com.webyar.operator.ui.components.ShapeFrame
import com.webyar.operator.ui.design.ExpressiveShapes
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.components.OperatorAvatar

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
            .padding(horizontal = Space.lg, vertical = Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        // The face on a scalloped cookie — the same frame the settings card
        // gives it, larger, because here it is the subject.
        Box(Modifier.size(136.dp), contentAlignment = Alignment.Center) {
            ShapeFrame(
                polygon = ExpressiveShapes.cookie9,
                color = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.fillMaxSize(),
            )
            OperatorAvatar(imageUrl = avatarUrl, size = 104.dp)
        }

        Row(
            horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.CenterHorizontally),
            modifier = Modifier.fillMaxWidth(),
        ) {
            FilledTonalButton(onClick = onPickAvatar, enabled = !busy) {
                Text(Str.changePhoto(language))
            }
            if (avatarUrl != null) {
                OutlinedButton(onClick = onRemoveAvatar, enabled = !busy) {
                    Text(Str.removePhoto(language))
                }
            }
        }

        Surface(
            color = groupColor(),
            shape = RoundedCornerShape(Radius.xl - 8.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                Modifier.padding(Space.lg),
                verticalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                FilledField(
                    value = firstName,
                    onValueChange = onFirstNameChange,
                    label = Str.firstName(language),
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                FilledField(
                    value = lastName,
                    onValueChange = onLastNameChange,
                    label = Str.lastName(language),
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                FilledField(
                    value = phone,
                    onValueChange = onPhoneChange,
                    label = Str.phoneLabel(language),
                    enabled = !busy,
                    // A number, and a Latin one wherever the interface
                    // language puts its own digits: a phone number typed in
                    // Persian digits is not a phone number anyone can dial.
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    ltr = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        if (email != null) {
            // Read-only: changing the address is an identity change that has
            // to go through verification, and the console is where that
            // lives. Showing it as a fact rather than a field is honest;
            // showing an editable field that 403s is not.
            Surface(
                color = groupColor(),
                shape = RoundedCornerShape(Radius.xl - 8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                DetailRow(
                    label = Str.emailLabel(language),
                    value = email,
                    latin = true,
                    icon = Icons.Outlined.Email,
                )
            }
        }

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
