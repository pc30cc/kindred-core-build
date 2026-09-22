package com.webyar.operator.baseline

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test

/**
 * The classes and methods a cold start actually touches.
 *
 * Compose ships its own baseline profile, which is why the app already
 * installs one — that covers the framework. This covers what is ours: the
 * theme, the fonts, the navigation graph, the API client, and the inbox's
 * first frame. Those are the ones the interpreter would otherwise walk
 * through on every install and every update.
 *
 * The journey stops at the inbox deliberately. A profile is a budget: every
 * method in it is AOT-compiled at install time, and padding it with screens
 * an operator reaches a minute later spends that budget on the wrong frame.
 */
class StartupProfile {

    @get:Rule val rule = BaselineProfileRule()

    @Test
    fun startup() = rule.collect(
        packageName = PACKAGE,
        // The default is three; five costs a few seconds here and produces a
        // steadier list on a machine that is also running a build.
        maxIterations = 5,
        stableIterations = 3,
        // Writes `startup-prof.txt` beside the baseline profile. That is a
        // separate artifact with a separate job: the baseline profile tells
        // ART what to compile ahead of time, the startup profile tells AGP
        // which classes to pack into the primary DEX so the loader opens one
        // file instead of several. Without this the plugin generates no
        // startup profile at all and says so on every build.
        includeInStartupProfile = true,
    ) {
        pressHome()
        startActivityAndWait()

        // The first frame is not the finished screen: the inbox arrives a
        // moment after the shell does, and stopping at "the activity is up"
        // would leave every list class out of the profile.
        device.wait(Until.hasObject(By.pkg(PACKAGE).depth(0)), 5_000)
        device.waitForIdle()
    }

    private companion object {
        const val PACKAGE = "com.webyar.operator"
    }
}
