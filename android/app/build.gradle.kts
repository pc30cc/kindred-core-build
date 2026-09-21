plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    // NOT `com.webyar.native`, which is what the iOS app is called.
    // `native` is a reserved word in Java, and the namespace becomes a real
    // package in generated sources (R, BuildConfig), so AGP rejects it. The
    // app's own vocabulary supplies the replacement: every screen in the iOS
    // source calls its user "the operator".
    namespace = "com.webyar.operator"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.webyar.operator"
        // Android 7.0. The market this ships to keeps devices far longer than
        // the Play Store's own charts suggest (ADR-003).
        minSdk = 24
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    androidResources {
        // Persian and Turkish are shipped, not merely tolerated: without this
        // the resource shrinker can drop the very translations the language
        // picker offers. (`resourceConfigurations` was the AGP 8 spelling.)
        localeFilters += setOf("en", "fa", "tr")
    }

    buildFeatures { compose = true }


    testOptions {
        unitTests {
            // Robolectric reads the merged manifest and resources; without
            // this every Compose test on the JVM fails looking for them.
            isIncludeAndroidResources = true
        }
    }
}

// The Kotlin Gradle Plugin's own block, deliberately outside `android {}`:
// the nested `kotlinOptions` spelling is gone in AGP 9.
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.ui.tooling.preview)

    // @Preview renders through this; debug-only so it never ships.
    debugImplementation(libs.androidx.compose.ui.tooling)
}
