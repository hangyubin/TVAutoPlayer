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
        // nextlib 的 FFmpeg 音频扩展只发布在 JitPack 上。
        maven("https://jitpack.io")
    }
}

rootProject.name = "TVAutoPlayer"
include(":app")
