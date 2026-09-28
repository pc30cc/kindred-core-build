package com.webyar.ai.feature.auth

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.webyar.ai.R
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.BrandFooterOverlay
import com.webyar.ai.ui.components.BrandPalette

/**
 * What a launch shows while it confirms the session: the Mac app's
 * `SplashView` — the brand mark with a soft blue glow under it, a small
 * spinner, and one quiet line saying what is happening.
 *
 * It follows the system's own splash (the icon on the launch colour) and
 * gives way to the inbox or to sign in. The "WEBYAR AI" signature at the foot
 * is the iOS launch screen's, and it stays exactly where it is into sign in.
 */
@Composable
fun RestoringScreen(language: Language, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface)
            .testTag(A11y.RESTORING),
    ) {
        Column(
            Modifier.align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Image(
                painter = painterResource(R.drawable.brand_mark),
                contentDescription = null,
                modifier = Modifier
                    .size(72.dp)
                    // The mark's own corner, so the glow follows its outline
                    // rather than a square around it.
                    .shadow(
                        elevation = 18.dp,
                        shape = RoundedCornerShape(16.dp),
                        ambientColor = BrandPalette.deep.copy(alpha = 0.35f),
                        spotColor = BrandPalette.deep.copy(alpha = 0.35f),
                    ),
            )
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Text(
                StrAndroid.restoringSession(language),
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        BrandFooterOverlay()
    }
}
