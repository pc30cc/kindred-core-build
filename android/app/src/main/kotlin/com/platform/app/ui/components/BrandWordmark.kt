package com.platform.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import com.platform.app.i18n.BrandStr
import com.platform.app.i18n.Language
import com.platform.app.ui.design.Space

/**
 * The name, above the login form.
 *
 * A Persian wordmark may be written with stretched kashida rather than the
 * plain spelling the rest of the app uses, because that is the brand's own
 * lettering and a logo is not body copy. It comes from
 * `BrandStr.brandWordmark` (each flavor's `BrandCopy`; RESPOK's is its
 * name, Latin in every language), so the three languages stay in one place
 * with the rest of the strings.
 *
 * A screen reader gets the ordinary spelling instead: the stretched form is a
 * picture of the name, and reading its kashida aloud is nonsense.
 */
@Composable
fun BrandWordmark(
    language: Language,
    modifier: Modifier = Modifier,
    tagline: String? = null,
) {
    Column(
        modifier.semantics(mergeDescendants = true) {
            contentDescription = BrandStr.appName(language)
        },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Text(
            text = BrandStr.brandWordmark(language),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center,
            modifier = Modifier.clearAndSetSemantics { },
        )
        if (tagline != null) {
            Text(
                text = tagline,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}
