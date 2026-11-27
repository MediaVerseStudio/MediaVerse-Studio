plugins {
    id("com.android.application")
}

android {
    namespace = "studio.mediaverse.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "studio.mediaverse.app"
        // Android 11: MediaStore gives genres, album artists and disc numbers directly.
        minSdk = 30
        targetSdk = 37
        versionCode = 3
        versionName = "0.9.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // The release signing key lives outside the repository: tools/build-android.ps1 -Release puts its location and passwords in these environment variables
    // (from %USERPROFILE%\.mediaverse\android-release.properties). Without them the release build is simply unsigned.
    val keystorePath = System.getenv("MEDIAVERSE_KEYSTORE")
    if (keystorePath != null) {
        signingConfigs {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("MEDIAVERSE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("MEDIAVERSE_KEY_ALIAS")
                keyPassword = System.getenv("MEDIAVERSE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The phone's web front end, built by `npm run phone:build` in web/app into web/app/dist-phone/web.
    sourceSets {
        getByName("main") {
            assets.directories.add("../../../web/app/dist-phone")
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    val media3 = "1.11.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-session:$media3")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    testImplementation("junit:junit:4.13.2")
    // On-device tests (test only, never shipped): connect to the service the way Android Auto does.
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
