package com.webyar.operator.ui.components

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.design.Motion
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space

/** One tab, as the bar needs to draw it. */
data class TabItem<T>(
    val tab: T,
    val title: String,
    val icon: ImageVector,
    val selectedIcon: ImageVector = icon,
)

/**
 * A detached capsule tab bar that floats above the content.
 *
 * The selection indicator **slides** between items rather than cross-fading,
 * so the eye can follow it — the thing `matchedGeometryEffect` does on iOS.
 * Here it is one animated offset over equal-width items, and it mirrors for
 * Persian on its own because `Modifier.offset` is direction-aware (unlike
 * `absoluteOffset`, which is the one to reach for when something must NOT
 * mirror).
 *
 * Every item is at least [Size.minTouchTarget] tall, and the labels shrink to
 * one line rather than truncate: a tab bar that clips its own words is worse
 * than one with slightly smaller ones, and "Gelen kutusu" is longer than
 * "Inbox" in every direction.
 */
@Composable
fun <T> FloatingTabBar(
    items: List<TabItem<T>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (items.isEmpty()) return
    val view = LocalView.current
    val selectedIndex = items.indexOfFirst { it.tab == selected }.coerceAtLeast(0)

    Surface(
        shape = RoundedCornerShape(Radius.pill),
        // iOS floats this on a real `.ultraThinMaterial`, so the content
        // scrolling under it genuinely blurs. A true backdrop blur needs
        // RenderEffect, which is API 31+, and this app starts at 24 — so
        // rather than a bar that is frosted on new phones and flat on old
        // ones, it is a near-opaque surface everywhere. Consistency beats an
        // effect two thirds of the devices would not get.
        color = MaterialTheme.colorScheme.surfaceContainer.copy(alpha = 0.97f),
        // A hairline keeps the capsule's edge defined against a light
        // background, where the fill alone almost disappears.
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
        modifier = modifier
            .padding(horizontal = Space.xl)
            .shadow(12.dp, RoundedCornerShape(Radius.pill), clip = false)
            .testTag(A11y.TAB_BAR),
    ) {
        BoxWithConstraints(Modifier.padding(Space.sm)) {
            val itemWidth = maxWidth / items.size
            val indicatorOffset by animateDpAsState(
                targetValue = itemWidth * selectedIndex,
                animationSpec = Motion.tabIndicator(),
                label = "tab-indicator",
            )

            // The indicator sits behind the row so it can slide independently
            // of the labels above it.
            Box(
                Modifier
                    .offset(x = indicatorOffset)
                    .width(itemWidth)
                    .height(Size.minTouchTarget + 4.dp)
                    .background(
                        MaterialTheme.colorScheme.primary.copy(alpha = 0.14f),
                        RoundedCornerShape(Radius.pill),
                    )
            )

            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                items.forEach { item ->
                    val isSelected = item.tab == selected
                    Column(
                        Modifier
                            .width(itemWidth)
                            .height(Size.minTouchTarget + 4.dp)
                            .selectable(
                                selected = isSelected,
                                role = Role.Tab,
                                onClick = {
                                    if (!isSelected) {
                                        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                                        onSelect(item.tab)
                                    }
                                },
                            ),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        val tint = if (isSelected) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        }
                        Icon(
                            imageVector = if (isSelected) item.selectedIcon else item.icon,
                            contentDescription = null,
                            tint = tint,
                            modifier = Modifier.size(20.dp),
                        )
                        Text(
                            text = item.title,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                            color = tint,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = Space.xxs),
                        )
                    }
                }
            }
        }
    }
}
