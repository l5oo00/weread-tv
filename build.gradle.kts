// 根工程：只声明插件版本，实际配置在 app/build.gradle.kts
// 若 Android Studio 提示插件/AGP 版本过旧，直接接受它给出的升级建议即可，代码不用改。
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
