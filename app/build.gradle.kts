plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.wereadtv.shell"
    compileSdk = 36                 // GeckoView 140 要求 >=35；本机已有 android-36

    buildFeatures {
        buildConfig = true
    }

    defaultConfig {
        applicationId = "com.wereadtv.shell"
        minSdk = 23                 // Android 6.0，覆盖绝大多数电视盒子
        targetSdk = 34
        versionCode = 3
        versionName = "0.3.0"
    }

    // 按 abi 出包，自适应机型：32 位老盒子选 v7a，64 位电视选 arm64。
    // GeckoView 的 per-abi 构件共享同一 capability，无法打进同一个 APK。
    flavorDimensions += "abi"
    productFlavors {
        create("v7a") {
            dimension = "abi"
            ndk { abiFilters += "armeabi-v7a" }
        }
        create("arm64") {
            dimension = "abi"
            ndk { abiFilters += "arm64-v8a" }
        }
    }

    // 发布构建：默认不开 R8/混淆（GeckoView 含原生库，盲目混淆有风险）；
    // 签名优先读仓库根 signing.properties，缺失时兜底复用 debug keystore，
    // 让 assemble*Release 直接出可装包。正式分发请用独立密钥（见 CONTRIBUTING）。
    signingConfigs {
        create("release") {
            val propsFile = rootProject.file("signing.properties")
            if (propsFile.exists()) {
                // 按行解析 KEY=VALUE（避免依赖 java.util.Properties）
                val map = propsFile.readLines()
                    .mapNotNull { line ->
                        val idx = line.indexOf('=')
                        if (idx <= 0) null else line.substring(0, idx).trim() to line.substring(idx + 1).trim()
                    }.toMap()
                storeFile = file(map["STORE_FILE"].toString())
                storePassword = map["STORE_PASSWORD"].toString()
                keyAlias = map["KEY_ALIAS"].toString()
                keyPassword = map["KEY_PASSWORD"].toString()
            } else {
                storeFile = file(System.getProperty("user.home") + "/.android/debug.keystore")
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // CI 会跑 lintV7aDebug。GeckoView 传递依赖里的 exoplayer2 会触发
    // NotificationPermission，但本 App 从不发通知，也不申请该权限，属第三方误报；
    // 其余告警（OldTargetApi / ChromeOsAbiSupport 等）保留，不掩盖真实问题。
    lint {
        disable.add("NotificationPermission")
        // GeckoView 140 + compileSdk 36 下，AGP lint 的 Kotlin 分析器会因
        // NonNullableMutableLiveDataDetector 自身类/接口不兼容而崩溃（与本 App 代码无关）。
        disable.add("NullSafeMutableLiveData")
    }

    // 运行时故意不引任何依赖（含 AndroidX）：整个 App 只有一个 Activity + 一个 GeckoView。
    // 仅 JVM 单测用 JUnit，testImplementation 不进 APK。
}

dependencies {
    testImplementation("junit:junit:4.13.2")

    // 自带 Gecko 引擎（Firefox 同款）：实测那台电视的系统 WebView 是 Chromium 74，
    // 编译不了阅读器新用的 WebAssembly（bulk-memory），整页正文渲染不出来。
    // 140 在真机上中文排版明显快于 128 ESR（正文首现 -6.6s），两个 abi 保持一致。
    "v7aImplementation"("org.mozilla.geckoview:geckoview-armeabi-v7a:140.0.20250707120347")
    "arm64Implementation"("org.mozilla.geckoview:geckoview-arm64-v8a:140.0.20250707120347")
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}
