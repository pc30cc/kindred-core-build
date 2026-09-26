package com.webyar.operator.feature.email

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrEmail
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.FilledField
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.LoadingIndicator
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * Writing a mail: the addresses, the subject, the words and the files.
 *
 * The addresses and the subject are laid out left to right in every
 * language — they are addresses, and a subject line usually quotes one —
 * while the body follows whatever it is written in.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EmailComposeScreen(
    form: EmailComposeForm,
    language: Language,
    onToChange: (String) -> Unit,
    onCcChange: (String) -> Unit,
    onBccChange: (String) -> Unit,
    onShowCopies: () -> Unit,
    onSubjectChange: (String) -> Unit,
    onBodyChange: (String) -> Unit,
    onRemoveAttachment: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (!form.ready) {
        Box(modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
        return
    }
    val addressKeyboard = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next)

    Column(
        modifier
            .fillMaxSize()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Space.screenInset, vertical = Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        FilledField(
            value = form.to,
            onValueChange = onToChange,
            label = StrEmail.to(language),
            supportingText = StrEmail.addressesHint(language),
            keyboardOptions = addressKeyboard,
            enabled = !form.sending,
            ltr = true,
            modifier = Modifier.fillMaxWidth().testTag(A11y.EMAIL_COMPOSE_TO),
        )
        if (form.showCopies) {
            FilledField(
                value = form.cc,
                onValueChange = onCcChange,
                label = StrEmail.cc(language),
                keyboardOptions = addressKeyboard,
                enabled = !form.sending,
                ltr = true,
                modifier = Modifier.fillMaxWidth(),
            )
            FilledField(
                value = form.bcc,
                onValueChange = onBccChange,
                label = StrEmail.bcc(language),
                keyboardOptions = addressKeyboard,
                enabled = !form.sending,
                ltr = true,
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            TextButton(onClick = onShowCopies) { Text(StrEmail.ccBcc(language)) }
        }
        FilledField(
            value = form.subject,
            onValueChange = onSubjectChange,
            label = StrEmail.subject(language),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
            enabled = !form.sending,
            modifier = Modifier.fillMaxWidth().testTag(A11y.EMAIL_COMPOSE_SUBJECT),
        )
        FilledField(
            value = form.body,
            onValueChange = onBodyChange,
            label = StrEmail.body(language),
            singleLine = false,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            enabled = !form.sending,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 220.dp)
                .testTag(A11y.EMAIL_COMPOSE_BODY),
        )

        if (form.attachments.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(Space.sm),
                verticalArrangement = Arrangement.spacedBy(Space.sm),
                modifier = Modifier.padding(top = Space.xs),
            ) {
                form.attachments.forEach { attachment ->
                    ComposeAttachmentChip(attachment, language) { onRemoveAttachment(attachment.localId) }
                }
            }
        }
    }
}

@Composable
private fun ComposeAttachmentChip(attachment: ComposeAttachment, language: Language, onRemove: () -> Unit) {
    Surface(
        color = if (attachment.failed) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceContainerHighest,
        shape = RoundedCornerShape(Radius.lg),
    ) {
        Row(
            Modifier.padding(start = Space.md, end = Space.xxs, top = Space.xxs, bottom = Space.xxs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (attachment.uploading) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            } else {
                Icon(Glyph.Document, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
            }
            Column(Modifier.padding(horizontal = Space.sm)) {
                LatinText(attachment.filename, style = MaterialTheme.typography.labelLarge, maxLines = 1)
                Text(
                    when {
                        attachment.failed -> StrEmail.uploadFailed(language)
                        attachment.uploading -> StrEmail.uploading(language)
                        else -> Format.fileSize(attachment.sizeBytes, language)
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = WebyarTheme.colors.labelTertiary,
                )
            }
            IconButton(onClick = onRemove, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Filled.Close, contentDescription = StrEmail.removeAttachment(language), modifier = Modifier.size(16.dp))
            }
        }
    }
}
