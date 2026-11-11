pluginManagement {
    repositories {
        // 国内镜像优先，拉不到再回官方源
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.mozilla.org/maven2") }   // GeckoView 只发布在这里
        google()
        mavenCentral()
    }
}

rootProject.name = "WeReadTV"
include(":app")
