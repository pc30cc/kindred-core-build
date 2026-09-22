pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()

        // JitPack, for ONE group and nothing else.
        //
        // LiveKit depends on `com.github.davidliu:audioswitch` at a commit
        // hash, which is published nowhere else. JitPack builds whatever a
        // GitHub coordinate points at on demand, so an unfiltered entry here
        // would let any `com.github.*` coordinate — including one typo-squatted
        // on a name we do use — resolve from a repository nobody reviews. The
        // content filter is what keeps that to the single dependency that
        // actually needs it.
        maven {
            url = uri("https://jitpack.io")
            content { includeGroup("com.github.davidliu") }
        }
    }
}

rootProject.name = "Webyar"
include(":app")
