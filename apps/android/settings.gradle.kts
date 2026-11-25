// MediaVerse Studio for Android phones (and Android Auto): a native Media3 player with the web front end in a
// WebView. See docs/android-app.md.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "MediaVerseAndroid"
include(":app")
