plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    // Consumes the profile the `:baselineprofile` module generates and packs
    // it into the APK's assets, where ProfileInstaller finds it.
    alias(libs.plugins.androidx.baselineprofile)
    // Room's annotation processor, and the plugin that exports its schema.
    alias(libs.plugins.ksp)
    alias(libs.plugins.androidx.room)
    // Screenshot tests: `recordRoborazziWebyarDebug` writes the PNGs.
    alias(libs.plugins.roborazzi)
}

/**
 * A release value, from a Gradle property or the environment.
 *
 * Property first so `-Pwebyar.versionCode=42` beats a stale shell export,
 * which is the order somebody debugging a wrong version number expects.
 */
fun releaseString(property: String, variable: String): String? =
    (project.findProperty(property) as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv(variable)?.takeIf { it.isNotBlank() }

fun releaseInt(property: String, variable: String): Int? =
    releaseString(property, variable)?.toIntOrNull()

/** A Kotlin/Java string literal, for `buildConfigField`. */
fun literal(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

/**
 * Firebase's client configuration — for push — from the build, never from a
 * committed google-services.json, under the brand's own names:
 * `-Pwebyar.firebase.appId` or `WEBYAR_FIREBASE_APP_ID` for WebYar,
 * `-Prespok.firebase.appId` or `RESPOK_FIREBASE_APP_ID` for RESPOK, and so on.
 *
 * A build without these is a build without push of its own: the app then
 * takes the project Super Admin names, which is what every release, every
 * fork, every CI run and every debug build on a laptop wants. A value set
 * here wins over Super Admin's (`core/push/PushConfig.kt`), which is why each
 * brand reads only its own: WebYar's exported in a shell must never send
 * RESPOK's phones to WebYar's Firebase project.
 */
fun com.android.build.api.dsl.VariantDimension.firebase(brand: String, env: String) {
    fun value(property: String, variable: String) =
        literal(releaseString("$brand.firebase.$property", "${env}_FIREBASE_$variable") ?: "")
    buildConfigField("String", "FIREBASE_APP_ID", value("appId", "APP_ID"))
    buildConfigField("String", "FIREBASE_API_KEY", value("apiKey", "API_KEY"))
    buildConfigField("String", "FIREBASE_PROJECT_ID", value("projectId", "PROJECT_ID"))
    buildConfigField("String", "FIREBASE_SENDER_ID", value("senderId", "SENDER_ID"))
}

/**
 * Whether this invocation is producing an App Bundle rather than APKs.
 *
 * Read from the tasks actually asked for, because the two cannot both be
 * configured: see the note in `splits`. Only the task's own name is matched,
 * so a path like `:app:bundleWebyarRelease` counts and an unrelated `:app:assemble`
 * does not.
 */
val buildingAppBundle: Boolean = gradle.startParameter.taskNames.any {
    it.substringAfterLast(':').startsWith("bundle")
}

android {
    // The code's package, the same for both brands: R, BuildConfig, the
    // ProGuard keep rules, the Room schema folder and the baseline profile
    // all name classes by it. What a phone knows an app by is the
    // applicationId, which each brand sets below.
    namespace = "com.webyar.ai"
    compileSdk = 37

    defaultConfig {
        // Android 7.0. The market this ships to keeps devices far longer than
        // the Play Store's own charts suggest (ADR-003).
        minSdk = 24
        targetSdk = 37

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            // The four ABIs that exist.
            //
            // WebRTC and JNA between them ship native libraries for seven,
            // including mips, mips64 and armeabi — architectures Android
            // stopped supporting in 2019, 2019 and 2019 respectively. Nothing
            // this app will ever be installed on can run them, and they are
            // 51MB of a 74MB debug APK.
            //
            // x86 and x86_64 stay because they are what every emulator is,
            // and a developer build that cannot run on the machine it was
            // built on is a developer build nobody tests.
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
        }
    }

    signingConfigs {
        /**
         * Each brand's release key, from the environment: `WEBYAR_KEYSTORE`,
         * `WEBYAR_KEYSTORE_PASSWORD`, `WEBYAR_KEY_ALIAS`, `WEBYAR_KEY_PASSWORD`,
         * and the same four with `RESPOK_`.
         *
         * No keystore, no password and no alias is committed. A release build
         * on a machine without them produces an unsigned APK, which is the
         * correct outcome: an unsigned artifact cannot be installed by
         * accident, whereas one signed with a key from the repository can be
         * installed by anybody who has ever cloned it.
         *
         * WebYar's is the key every WebYar release so far was signed with,
         * and must stay so: a phone refuses an update signed by another.
         */
        for ((brand, env) in listOf("webyar" to "WEBYAR", "respok" to "RESPOK")) {
            create("${brand}Release") {
                val store = System.getenv("${env}_KEYSTORE")
                if (store != null && file(store).exists()) {
                    storeFile = file(store)
                    storePassword = System.getenv("${env}_KEYSTORE_PASSWORD")
                    keyAlias = System.getenv("${env}_KEY_ALIAS")
                    keyPassword = System.getenv("${env}_KEY_PASSWORD")
                }
            }
        }
    }

    /**
     * Two apps from one source, installable side by side: WebYar (the Iranian
     * edition, webyar.ai) and RESPOK (the International edition, respok.app).
     * The Windows app makes the same split with `Brand.cs`, the Mac app with
     * its `Respok` target; `core/AppBrand.kt` reads what is set here.
     *
     * Everything that differs is in these two blocks or in `src/respok`
     * (name, icons, launch colours); the rest is shared. Every task names its
     * brand: `assembleWebyarRelease`, `bundleRespokRelease`,
     * `testRespokDebugUnitTest`.
     */
    flavorDimensions += "brand"
    productFlavors {
        create("webyar") {
            dimension = "brand"
            // The same identifier as the iOS app (`PRODUCT_BUNDLE_IDENTIFIER`
            // in ios/Webyar/project.yml): one name for the product on both
            // stores. Releases up to 1.0.1 are `com.webyar.operator`, which
            // Android treats as a different app: a phone with one installs
            // this beside it rather than over it, and the old one is removed
            // by hand.
            applicationId = "com.webyar.ai"
            // Play refuses an upload whose versionCode it has seen before, and
            // it never forgets one — so the number cannot live only in this
            // file, where two releases cut from the same commit would collide
            // and a hotfix would mean editing source to ship it.
            //
            // The default is what a developer building locally wants: a stable
            // number they never have to think about. A release pipeline passes
            // its own, and docs/ANDROID_RELEASE.md says which.
            versionCode = releaseInt("webyar.versionCode", "WEBYAR_VERSION_CODE") ?: 1
            versionName = releaseString("webyar.versionName", "WEBYAR_VERSION_NAME") ?: "0.1.0"
            signingConfig = signingConfigs.getByName("webyarRelease").takeIf { it.storeFile != null }

            buildConfigField("String", "BRAND_ID", literal("webyar"))
            buildConfigField("String", "BRAND_NAME", literal("Webyar"))
            // The first request of a fresh install; the platform moves it
            // later (/api/platform/origins, core/storage/Settings.kt).
            buildConfigField("String", "API_BASE_URL", literal("https://api.webyar.ai"))
            buildConfigField("String", "DEFAULT_LANGUAGE", literal("fa"))
            buildConfigField("boolean", "JALALI_DATES", "true")
            buildConfigField("String", "REALTIME_CLIENT_NAME", literal("webyar-android"))
            firebase("webyar", "WEBYAR")
        }
        create("respok") {
            dimension = "brand"
            // RESPOK's own: mobile_app_settings.android_package_name in its
            // database, which Super Admin uses to pick this app's client out
            // of a google-services.json.
            applicationId = "com.respok.app"
            // RESPOK's own numbers first; then the ones a WebYar-shaped
            // command passes (Super Admin's build command uses
            // -Pwebyar.versionCode for both brands), so either builds the
            // version asked for.
            versionCode = releaseInt("respok.versionCode", "RESPOK_VERSION_CODE")
                ?: releaseInt("webyar.versionCode", "WEBYAR_VERSION_CODE") ?: 1
            versionName = releaseString("respok.versionName", "RESPOK_VERSION_NAME")
                ?: releaseString("webyar.versionName", "WEBYAR_VERSION_NAME") ?: "1.0.0"
            signingConfig = signingConfigs.getByName("respokRelease").takeIf { it.storeFile != null }

            buildConfigField("String", "BRAND_ID", literal("respok"))
            buildConfigField("String", "BRAND_NAME", literal("RESPOK"))
            buildConfigField("String", "API_BASE_URL", literal("https://api.respok.app"))
            // The International edition: Persian is a language to pick, never
            // the default, and its dates stay Gregorian (in Persian digits).
            buildConfigField("String", "DEFAULT_LANGUAGE", literal("en"))
            buildConfigField("boolean", "JALALI_DATES", "false")
            buildConfigField("String", "REALTIME_CLIENT_NAME", literal("respok-android"))
            firebase("respok", "RESPOK")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            // The package carries no record of the repository it was built
            // from: no commit, no branch, no remote.
            vcsInfo.include = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")

            // NO signingConfig here, ever: each brand's flavor names its own
            // key. A build type's signingConfig wins over a flavor's, so one
            // set here would sign both apps with it — RESPOK with WebYar's key
            // or the other way round, which Play then binds to that app for
            // good. The check after this block refuses that build.
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

    // See the note in `release`: a key there would sign both brands with it.
    check(buildTypes.getByName("release").signingConfig == null) {
        "buildTypes.release must not set a signingConfig: each brand's flavor names its own release key"
    }

    /**
     * The minified build is a RELEASE build, so it gets the release sources.
     *
     * Which matters for exactly one file: `Backend`. There are two of them,
     * one per source set, and the release one cannot name `SampleApi` because
     * `SampleApi` is not on its classpath — that is what makes the sample
     * backend impossible to reach in a shipped app rather than merely
     * switched off in one. A minified build with the debug `Backend` would be
     * testing the wrong app; a minified build with neither does not compile.
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
            // Off while building a bundle, and AGP is right to insist:
            // a bundle does its own ABI splitting, and better — Play
            // delivers one device exactly the native code it can run,
            // where these APKs make somebody choose. With both on, the
            // bundle task finds five shrunk-resource files where it
            // expects one and fails outright
            // (`buildReleasePreBundle`, issuetracker 402800800), so the
            // one artifact Play accepts could never be produced.
            //
            // They stay on for APK builds, which is what a sideload, the
            // minified build and CI all want.
            isEnable = !buildingAppBundle
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

/**
 * One profile in `src/main`, not a copy per variant.
 *
 * `mergeIntoMain` is a property of the CONSUMER — the module that ships the
 * profile — not of the module that generates it. Without it the plugin writes
 * the same 1.6MB of rules into `src/release/generated` and
 * `src/minified/generated`: two identical files, in a repository, that a
 * later run can update one of. `minified` exists so the R8'd build can be
 * installed and looked at; it has no business having its own idea of what to
 * compile ahead of time.
 */
baselineProfile {
    mergeIntoMain = true
}

/**
 * The cache's schema, one JSON file per version, committed.
 *
 * What a migration is written against — the schema that actually shipped,
 * rather than somebody's memory of it — and what the migration tests read.
 */
room {
    schemaDirectory("$projectDir/schemas")
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
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    implementation(libs.androidx.compose.material3.adaptive)
    implementation(libs.androidx.compose.material3.adaptive.layout)
    implementation(libs.androidx.compose.material3.adaptive.navigation3)
    implementation(libs.androidx.compose.material3.adaptive.navigation.suite)
    implementation(libs.androidx.graphics.shapes)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.lifecycle.process)

    // The local cache: the inbox and transcripts on screen before any
    // request, and offline.
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    // Deferred work only: a push registration that needs a network, the
    // daily cache trim. Never polling.
    implementation(libs.androidx.work.runtime.ktx)

    // FCM, and nothing else of Firebase — no analytics, no crash reporting.
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.serialization.kotlinx.json)
    // Network logging, installed only when BuildConfig.DEBUG is true. That is
    // a compile-time constant, so R8 removes the branch and the plugin with
    // it from the shipped app.
    implementation(libs.ktor.client.logging)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    implementation(libs.livekit.android)
    implementation(libs.osmdroid.android)

    // Installs the generated profile at first run. Already on the classpath
    // transitively through Compose — named here because the app ships a
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
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.androidx.room.testing)
    testImplementation(libs.androidx.work.testing)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
