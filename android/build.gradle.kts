plugins {
    alias(libs.plugins.android.application) apply false
    // NOT `org.jetbrains.kotlin.android`. AGP 9 compiles Kotlin itself and
    // refuses to start if that plugin is also applied:
    //   "The 'org.jetbrains.kotlin.android' plugin is no longer required for
    //    Kotlin support since AGP 9.0."
    // The Compose compiler plugin below is a different plugin and is still
    // required; declaring it at 2.4.20 is also what puts KGP 2.4.20 on the
    // build classpath, above the 2.2.10 AGP would otherwise supply, and keeps
    // the compiler plugin and the language on the same version.
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.android.test) apply false
    alias(libs.plugins.androidx.baselineprofile) apply false
}
