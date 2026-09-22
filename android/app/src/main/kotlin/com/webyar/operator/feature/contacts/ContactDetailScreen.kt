package com.webyar.operator.feature.contacts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import com.webyar.operator.core.model.Contact
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.DetailRow
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.RowDivider
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space

/**
 * One contact's details: a centred identity block, then the facts.
 *
 * Every fact is optional and most contacts have only one of them, so the
 * section is built from what exists rather than laid out and blanked — an
 * anonymous visitor gets a code and a first-seen date and no empty rows
 * where an address and a phone number would have been.
 */
@Composable
fun ContactDetailScreen(
    contact: Contact?,
    language: Language,
    modifier: Modifier = Modifier,
    profile: VisitorProfile? = null,
    contentPadding: PaddingValues = PaddingValues(),
) {
    if (contact == null) {
        // Reachable: the list is dropped when the workspace changes, and a
        // detail screen left on the stack outlives the row that opened it.
        EmptyState(
            icon = Icons.Filled.Person,
            title = Str.contactsEmptyTitle(language),
            body = null,
            modifier = modifier.fillMaxSize(),
        )
        return
    }

    val name = Format.contactName(
        name = contact.name,
        email = contact.email,
        visitorCode = contact.visitorCode,
        language = language,
    )

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(contentPadding)
            .testTag(A11y.CONTACT_DETAIL),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(vertical = Space.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Avatar(
                name = name,
                imageUrl = contact.avatarUrl,
                size = Size.avatarLarge,
                os = profile?.device?.os,
                device = profile?.device?.device,
                countryCode = profile?.geo?.countryCode,
            )
            Text(
                name,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = Space.screenInset),
            )
        }

        val facts = buildList {
            contact.email?.takeIf { it.isNotBlank() }?.let {
                add(Fact(Str.emailLabel(language), it, latin = true))
            }
            contact.phone?.takeIf { it.isNotBlank() }?.let {
                add(Fact(phoneLabel(language), it, latin = true))
            }
            contact.visitorCode?.takeIf { it.isNotBlank() }?.let {
                add(Fact(Str.unknownVisitor(language), it, latin = true))
            }
            contact.createdAt?.let {
                add(Fact(firstSeenLabel(language), Format.dayHeader(it, language)))
            }
            // Where they were and what they were on, when the server knew.
            // Less a fact about the contact than about the visit, which is why
            // these sit at the bottom rather than beside the address.
            profile?.geo?.let { geo ->
                val place = listOfNotNull(
                    geo.city?.takeIf { it.isNotBlank() },
                    geo.country?.takeIf { it.isNotBlank() },
                ).joinToString(if (language == Language.FA) "، " else ", ")
                if (place.isNotEmpty()) add(Fact(placeLabel(language), place))
            }
            profile?.device?.let { device ->
                val what = listOfNotNull(
                    device.os?.takeIf { it.isNotBlank() },
                    device.browser?.takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                if (what.isNotEmpty()) add(Fact(deviceLabel(language), what, latin = true))
            }
        }

        if (facts.isNotEmpty()) {
            RowDivider(inset = false)
            facts.forEachIndexed { index, fact ->
                DetailRow(label = fact.label, value = fact.value, latin = fact.latin)
                if (index < facts.lastIndex) RowDivider()
            }
            RowDivider(inset = false)
        }
    }
}

/**
 * One line of the facts section.
 *
 * `latin` says the value is the same string in every language — an address, a
 * number, a code, a browser name — and must not be mirrored.
 */
private data class Fact(val label: String, val value: String, val latin: Boolean = false)

// The four labels below are inline here rather than in `Str`, which is
// generated from `Strings.swift` — because iOS inlines them in its own view
// for the same reason: they are this screen's words and nowhere else's. If a
// second screen ever needs one, it belongs in the generator's source first.

private fun phoneLabel(l: Language): String = when (l) {
    Language.EN -> "Phone"
    Language.FA -> "تلفن"
    Language.TR -> "Telefon"
}

private fun firstSeenLabel(l: Language): String = when (l) {
    Language.EN -> "First seen"
    Language.FA -> "نخستین بازدید"
    Language.TR -> "İlk görülme"
}

private fun placeLabel(l: Language): String = when (l) {
    Language.EN -> "Location"
    Language.FA -> "موقعیت"
    Language.TR -> "Konum"
}

private fun deviceLabel(l: Language): String = when (l) {
    Language.EN -> "Device"
    Language.FA -> "دستگاه"
    Language.TR -> "Cihaz"
}
