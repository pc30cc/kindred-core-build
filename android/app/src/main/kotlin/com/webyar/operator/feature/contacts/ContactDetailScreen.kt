package com.webyar.operator.feature.contacts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.DateRange
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material3.Surface
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.components.SegmentGap
import com.webyar.operator.ui.components.ShapeFrame
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.components.segmentedShape
import com.webyar.operator.ui.design.ExpressiveShapes
import com.webyar.operator.ui.design.WebyarType
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
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space

/**
 * One contact's details: a centred identity block, then the facts as a
 * group of cards.
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
            .padding(bottom = Space.xl)
            .testTag(A11y.CONTACT_DETAIL),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(top = Space.sm, bottom = Space.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            // The avatar on a soft burst: the expressive shapes as a frame
            // that does not clip — the flag and the device badge on the
            // avatar's edge are part of who this is.
            Box(Modifier.size(HeroSize), contentAlignment = Alignment.Center) {
                ShapeFrame(
                    polygon = ExpressiveShapes.softBurst,
                    color = MaterialTheme.colorScheme.primaryContainer,
                    modifier = Modifier.fillMaxSize(),
                )
                Avatar(
                    name = name,
                    imageUrl = contact.avatarUrl,
                    size = Size.avatarLarge,
                    os = profile?.device?.os,
                    device = profile?.device?.device,
                    countryCode = profile?.geo?.countryCode,
                )
            }
            Text(
                name,
                style = WebyarType.headlineSmallEmphasized.bidiContent(),
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = Space.screenInset),
            )
        }

        val facts = buildList {
            contact.email?.takeIf { it.isNotBlank() }?.let {
                add(Fact(Str.emailLabel(language), it, latin = true, icon = Icons.Outlined.Email))
            }
            contact.phone?.takeIf { it.isNotBlank() }?.let {
                add(Fact(phoneLabel(language), it, latin = true, icon = Icons.Outlined.Phone))
            }
            contact.visitorCode?.takeIf { it.isNotBlank() }?.let {
                add(Fact(Str.unknownVisitor(language), it, latin = true, icon = Icons.Outlined.Person))
            }
            contact.createdAt?.let {
                add(Fact(firstSeenLabel(language), Format.dayHeader(it, language), icon = Icons.Outlined.DateRange))
            }
            // Where they were and what they were on, when the server knew.
            // Less a fact about the contact than about the visit, which is why
            // these sit at the bottom rather than beside the address.
            profile?.geo?.let { geo ->
                // A Latin comma, not the interface language's: the server
                // sends these as Latin place names, and «Berlin، Germany»
                // punctuates an English string with a Persian mark.
                val place = listOfNotNull(
                    geo.city?.takeIf { it.isNotBlank() },
                    // The name when the server resolved one, the ISO code when
                    // it only had that. Dropping to nothing would leave a
                    // visitor with a flag on their avatar and no country
                    // written anywhere.
                    geo.country?.takeIf { it.isNotBlank() }
                        ?: geo.countryCode?.takeIf { it.isNotBlank() }?.uppercase(),
                ).joinToString(", ")
                if (place.isNotEmpty()) {
                    add(Fact(placeLabel(language), place, latin = true, icon = Icons.Outlined.LocationOn))
                }
            }
            // When, not just where. The server picks the newest session to
            // speak for a contact, so this is the date on the facts above it.
            profile?.lastSeenAt?.let {
                add(Fact(lastSeenLabel(language), Format.dayHeader(it, language), icon = Icons.Outlined.DateRange))
            }
            profile?.device?.let { device ->
                val what = listOfNotNull(
                    device.os?.takeIf { it.isNotBlank() },
                    device.browser?.takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                if (what.isNotEmpty()) add(Fact(deviceLabel(language), what, latin = true, icon = Icons.Outlined.Info))
            }
        }

        if (facts.isNotEmpty()) {
            // One group of cards, a row each: the grouped lists of Android
            // 16, which read as one block and still let each fact stand alone.
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Space.lg),
                verticalArrangement = Arrangement.spacedBy(SegmentGap),
            ) {
                facts.forEachIndexed { index, fact ->
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        shape = segmentedShape(index, facts.size),
                    ) {
                        DetailRow(label = fact.label, value = fact.value, latin = fact.latin, icon = fact.icon)
                    }
                }
            }
        }
    }
}

private val HeroSize = 112.dp

/**
 * One line of the facts section.
 *
 * `latin` says the value is the same string in every language — an address, a
 * number, a code, a browser name — and must not be mirrored.
 */
private data class Fact(
    val label: String,
    val value: String,
    val latin: Boolean = false,
    val icon: ImageVector? = null,
)

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

private fun lastSeenLabel(l: Language): String = when (l) {
    Language.EN -> "Last seen"
    Language.FA -> "آخرین بازدید"
    Language.TR -> "Son görülme"
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
