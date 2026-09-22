plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    // Consumes the profile the `:baselineprofile` module generates and packs
    // it into the APK's assets, where ProfileInstaller finds it.
    alias(libs.plugins.androidx.baselineprofile)
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

        ndk {
            // The four ABIs that exist.
            //
            // WebRTC and JNA between them ship native libraries for seven,
            // including mips, mips64 and armeabi — architectures Android
            // stopped supporting in 2019, 2019 and 2019 respectively. Nothing
            // this app will ever be installed on can run them, and they were
            // 51MB of the debug APK's 74.
            //
            // x86 and x86_64 stay because they are what every emulator is,
            // and a developer build that cannot run on the machine it was
            // built on is a developer build nobody tests.
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
        }
    }

    signingConfigs {
        /**
         * The real one, from the environment.
         *
         * No keystore, no password and no alias is committed. A release build
         * on a machine without them produces an unsigned APK, which is the
         * correct outcome: an unsigned artifact cannot be installed by
         * accident, whereas one signed with a key from the repository can be
         * installed by anybody who has ever cloned it.
         */
        create("release") {
            val store = System.getenv("WEBYAR_KEYSTORE")
            if (store != null && file(store).exists()) {
                storeFile = file(store)
                storePassword = System.getenv("WEBYAR_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("WEBYAR_KEY_ALIAS")
                keyPassword = System.getenv("WEBYAR_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")

            signingConfig = signingConfigs.getByName("release").takeIf {
                it.storeFile != null
            }
        }

        /**
         * A release build that can be installed and looked at.
         *
         * R8 is the difference between the app that is tested and the app
         * that ships: it renames, inlines and deletes, and a keep rule that
         * is missing shows up as an inbox of blank rows rather than a crash.
         * This build type is minified exactly like release and signed with
         * the debug key, so somebody can actually run the thing R8 produced.
         */
        create("minified") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            signingConfig = signingConfigs.getByName("debug")
            applicationIdSuffix = ".minified"
            isDebuggable = false
        }
    }

    /**
     * The minified build is a RELEASE build, so it gets the release sources.
     *
     * Which matters for exactly one file: `Backend`. There are two of them,
     * one per source set, and the release one cannot name `SampleApi` because
     * `SampleApi` is not on its classpath — that is what makes the sample
     * backend impossible to reach in a shipped app rather than merely
     * switched off in one. A minified build with the debug `Backend` would be
     * testing the wrong app; a minified build with neither does not compile,
     * which is how this was found.
     */
    sourceSets.getByName("minified") {
        kotlin.srcDir("src/release/kotlin")
    }

    /**
     * One APK per architecture for anyone installing a file directly.
     *
     * The bundle Play serves already sends a phone only its own ABI, so this
     * is for the other route: a workspace that hands its operators an APK.
     * Without it that APK carries all four copies of WebRTC and is four times
     * the size it needs to be on any one phone.
     */
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
            isUniversalApk = true
        }
    }

    // AGP 9's built-in Kotlin takes its jvmTarget from here, so there is no
    // separate Kotlin block to keep in step with it.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // `java.time` is API 26; minSdk here is 24. Desugaring is what lets
        // the model layer use Instant rather than passing timestamps around as
        // strings and re-parsing them at every call site — which is what iOS
        // gets for free from Foundation.
        isCoreLibraryDesugaringEnabled = true
    }

    androidResources {
        // Persian and Turkish are shipped, not merely tolerated: without this
        // the resource shrinker can drop the very translations the language
        // picker offers. (`resourceConfigurations` was the AGP 8 spelling.)
        localeFilters += setOf("en", "fa", "tr")
    }

    buildFeatures {
        compose = true
        // For the version string the About row shows. Opt-in since AGP 8.
        buildConfig = true
    }


    testOptions {
        unitTests {
            // Robolectric reads the merged manifest and resources; without
            // this every Compose test on the JVM fails looking for them.
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.ui.tooling.preview)

    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.serialization.kotlinx.json)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    implementation(libs.livekit.android)

    // Installs the generated profile at first run. Already on the classpath
    // transitively through Compose — named here because the app now ships a
    // profile of its own and depends on it being installed.
    implementation(libs.androidx.profileinstaller)

    // The generator module. `baselineProfile` rather than a normal
    // dependency: it is a producer, and nothing from it reaches the APK.
    baselineProfile(project(":baselineprofile"))

    // @Preview renders through this; debug-only so it never ships.
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
