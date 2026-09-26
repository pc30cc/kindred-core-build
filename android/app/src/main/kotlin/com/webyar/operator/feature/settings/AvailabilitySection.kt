package com.webyar.operator.feature.settings

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.components.PillTone
import com.webyar.operator.ui.components.QuietRow
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.components.segmentedShape
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarType

/**
 * Whether the operator is taking work, and why.
 *
 * The three switches are not three ways of saying the same thing. "Force
 * offline" is a decision; "available while the app is open" and "follow my
 * schedule" are rules the server applies when there is no decision. The state
 * row at the top says what all that adds up to right now, which is the only
 * part a visitor ever sees.
 */
@Composable
fun AvailabilitySection(
    language: Language,
    state: AvailabilityState,
    saveFailed: Boolean,
    onSetForceOffline: (Boolean) -> Unit,
    onSetAvailableWhenUsingApp: (Boolean) -> Unit,
    onSetScheduleEnabled: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        AvailabilityState.Loading -> QuietRow("…", modifier)

        AvailabilityState.Failed -> QuietRow(Str.offlineTitle(language), modifier)

        is AvailabilityState.Loaded -> Group(modifier) {
            val prefs = state.response.prefs
            val online = state.response.status.isOnline
            val count = 4

            Surface(color = groupColor(), shape = segmentedShape(0, count), modifier = Modifier.fillMaxWidth()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = Size.rowMinHeight)
                        .padding(horizontal = Space.lg, vertical = Space.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        Str.availabilitySeenAs(language),
                        style = WebyarType.bodyLargeEmphasized,
                        modifier = Modifier.weight(1f),
                    )
                    StatusPill(
                        label = if (online) {
                            Str.availabilityOnline(language)
                        } else {
                            Str.availabilityOffline(language)
                        },
                        tone = if (online) PillTone.SUCCESS else PillTone.NEUTRAL,
                    )
                }
            }

            SwitchRow(
                index = 1,
                count = count,
                title = Str.availabilityForceOffline(language),
                hint = Str.availabilityForceOfflineHint(language),
                checked = prefs.forceOffline,
                onChange = onSetForceOffline,
            )
            SwitchRow(
                index = 2,
                count = count,
                title = Str.availabilityWhenUsingApp(language),
                hint = Str.availabilityWhenUsingAppHint(language),
                checked = prefs.availableWhenUsingApp,
                // A decision overrides the rules, so while "force offline" is
                // on these two cannot change anything and say so by being
                // unavailable rather than by silently doing nothing.
                enabled = !prefs.forceOffline,
                onChange = onSetAvailableWhenUsingApp,
            )
            SwitchRow(
                index = 3,
                count = count,
                title = Str.availabilitySchedule(language),
                hint = Str.availabilityScheduleHint(language),
                checked = prefs.scheduleEnabled,
                enabled = !prefs.forceOffline,
                onChange = onSetScheduleEnabled,
            )

            if (saveFailed) {
                Text(
                    Str.availabilitySaveFailed(language),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.sm),
                )
            }
        }
    }
}
