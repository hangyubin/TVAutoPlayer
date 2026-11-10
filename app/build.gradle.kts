plugins {
    id("com.android.application")
}

android {
    namespace = "com.chenwei.tvautoplay"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.chenwei.tvautoplay"
        minSdk = 23
        targetSdk = 36
        versionCode = 24
        versionName = "1.10.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // FFmpeg 软解库每个架构约 5 MB。arm64-v8a 是电视盒子主流，
        // x86_64 给 Android 模拟器调试用（模拟器普遍没有 HEVC 硬解，必须靠扩展软解）。
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = false
    }

    lint {
        lintConfig = file("lint.xml")
    }
}

dependencies {
    implementation("androidx.annotation:annotation:1.10.0")
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.media3:media3-exoplayer:1.10.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.10.1")
    implementation("androidx.media3:media3-ui:1.10.1")
    // 系统普遍缺少 AC-3 / E-AC-3 / DTS 解码器，用它兜底软解；能硬解的格式不受影响。
    implementation("com.github.anilbeesetti.nextlib:nextlib-media3ext:0.8.4")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
