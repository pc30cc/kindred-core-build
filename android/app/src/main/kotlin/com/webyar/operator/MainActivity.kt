package com.webyar.operator

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.WebyarTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            WebyarTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    ToolchainProof()
                }
            }
        }
    }
}

/**
 * The whole app, for now — and it has one job.
 *
 * ADR-003 sequences this first so the toolchain is proven end to end before
 * anything depends on it: Gradle resolves, Kotlin compiles, Compose renders,
 * the resource qualifiers pick the right language, and the layout turns
 * around when that language reads right-to-left.
 *
 * That last one is why the row below is a `Row` with a leading icon rather
 * than a lone paragraph. Text alone reads correctly in either direction and
 * so proves nothing; a row mirrors, and the icon moving to the other edge is
 * the thing you can actually see. Compose resolves `Arrangement.Start` and
 * padding against `LocalLayoutDirection`, so Persian should put the icon on
 * the right with no conditional anywhere in this file.
 *
 * On iOS the equivalent took a window-level override and an appearance proxy
 * — see `WindowDirection.swift`, and the bug where "Language" came out
 * "egaugnaL". Android supplies it from `android:supportsRtl` and the locale.
 */
@Composable
fun ToolchainProof(modifier: Modifier = Modifier) {
    val direction = when (LocalLayoutDirection.current) {
        LayoutDirection.Rtl -> "RTL"
        LayoutDirection.Ltr -> "LTR"
    }

    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // An auto-mirrored icon, so the proof is doubled: the Row
            // moves it to the other edge, and the glyph itself turns
            // around. A symmetrical icon would have shown only the first.
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null)
            Text(
                text = stringResource(R.string.skeleton_title),
                style = MaterialTheme.typography.headlineSmall,
            )
        }

        Text(
            text = stringResource(R.string.skeleton_body),
            style = MaterialTheme.typography.bodyMedium,
        )

        Text(
            text = "${stringResource(R.string.skeleton_direction_label)}: $direction",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}

// The Persian preview is the one that matters: it is the case the product
// ships in, and the only one where a layout built the wrong way round shows
// up in the canvas rather than on a device.
@Preview(name = "fa — RTL", locale = "fa", showBackground = true)
@Composable
private fun ToolchainProofPersian() {
    WebyarTheme { Surface { ToolchainProof() } }
}

@Preview(name = "en — LTR", locale = "en", showBackground = true)
@Composable
private fun ToolchainProofEnglish() {
    WebyarTheme { Surface { ToolchainProof() } }
}
