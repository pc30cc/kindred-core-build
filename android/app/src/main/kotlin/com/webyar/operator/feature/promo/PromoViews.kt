package com.webyar.operator.feature.promo

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Star
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.PromoCreative
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.BrandWordmark
import com.webyar.operator.ui.components.PrimaryButton
import com.webyar.operator.ui.components.RemoteImage
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * A promotional strip at the top of the inbox.
 *
 * Drawn as one of our own cards — brand tint, our type, our corner radius —
 * and never as anything that could be mistaken for a system notification, a
 * dialog or an Android control. That is a store rule on both platforms and it
 * is also simply how an operator tool should behave.
 */
@Composable
fun PromoBanner(
    creative: PromoCreative,
    language: Language,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uriHandler = LocalUriHandler.current

    Surface(
        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.07f),
        shape = RoundedCornerShape(Radius.lg),
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Space.screenInset, vertical = Space.xs)
            .testTag(A11y.PROMO_BANNER),
    ) {
        Row(
            Modifier.padding(start = Space.md, top = Space.sm, bottom = Space.sm),
            verticalAlignment = Alignment.Top,
        ) {
            Box(
                Modifier
                    .size(32.dp)
                    .background(
                        MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                        CircleShape,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Star,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(16.dp),
                )
            }

            Column(Modifier.weight(1f).padding(start = Space.md)) {
                Text(
                    creative.title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                if (creative.body.isNotEmpty()) {
                    Text(
                        creative.body,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                val link = creative.safeLink
                val label = creative.ctaLabel
                if (link != null && !label.isNullOrEmpty()) {
                    TextButton(
                        onClick = { uriHandler.openUri(link) },
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(
                            horizontal = 0.dp,
                            vertical = Space.xxs,
                        ),
                    ) {
                        Text(label, style = MaterialTheme.typography.labelLarge)
                    }
                }
            }

            // Small mark, full-size target. A close control people miss is
            // worse than none at all.
            IconButton(
                onClick = onDismiss,
                modifier = Modifier
                    .size(Size.minTouchTarget)
                    .testTag(A11y.PROMO_DISMISS),
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = Str.close(language),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

/**
 * The full-screen promotion.
 *
 * Everything a store asks of an interstitial is structural here rather than
 * optional: the close button is composed first, it is a full 48dp target, it
 * is never delayed behind a countdown, and nothing on the card imitates a
 * system surface. It is also never shown over a call or a conversation — only
 * the inbox offers one.
 */
@Composable
fun PromoFullScreen(
    creative: PromoCreative,
    language: Language,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uriHandler = LocalUriHandler.current

    Surface(
        color = MaterialTheme.colorScheme.background,
        modifier = modifier.fillMaxSize().testTag(A11y.PROMO_FULLSCREEN),
    ) {
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(horizontal = Space.screenInset),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                if (creative.imageUrl != null) {
                    RemoteImage(
                        url = creative.imageUrl,
                        contentDescription = null,
                        // Fit, not Crop, unlike the avatars: a promotion's
                        // artwork is composed, and cropping it to fill would
                        // cut the composition.
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .sizeIn(maxWidth = 260.dp, maxHeight = 220.dp)
                            .clip(RoundedCornerShape(Radius.xl)),
                        fallback = { BrandWordmark(language) },
                    )
                } else {
                    BrandWordmark(language)
                }

                Spacer(Modifier.heightIn(min = Space.xl))

                Text(
                    creative.title,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = Space.xl),
                )
                if (creative.body.isNotEmpty()) {
                    Text(
                        creative.body,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .widthIn(max = 320.dp)
                            .padding(top = Space.sm),
                    )
                }

                Spacer(Modifier.weight(1f))

                val link = creative.safeLink
                val label = creative.ctaLabel
                if (link != null && !label.isNullOrEmpty()) {
                    PrimaryButton(
                        label = label,
                        onClick = {
                            uriHandler.openUri(link)
                            onDismiss()
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                // A second way out, in words, under the button. The X is the
                // requirement; this is the one people actually reach for when
                // the card fills the screen.
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = Size.minTouchTarget)
                        .padding(bottom = Space.xl),
                ) {
                    Text(Str.notNow(language), style = MaterialTheme.typography.labelLarge)
                }
            }

            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = CircleShape,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(Space.md),
            ) {
                IconButton(
                    onClick = onDismiss,
                    modifier = Modifier
                        .size(Size.minTouchTarget)
                        .testTag(A11y.PROMO_DISMISS),
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = Str.close(language),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
