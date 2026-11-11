# 第三方组件与许可

本项目**自行编写的** Kotlin / JS 源码与文档采用 [MIT](./LICENSE)。
但分发用的 APK 内含第三方二进制，其中约 120MB 是 GeckoView 浏览器引擎
（APK 约 130MB / 162MB）。这些组件不受 MIT 覆盖，各自适用自己的许可。

## GeckoView 128

| 项 | 值 |
|---|---|
| 构件 | `org.mozilla.geckoview:geckoview-armeabi-v7a:128.0.20240725162350`、`org.mozilla.geckoview:geckoview-arm64-v8a:128.0.20240725162350` |
| 来源 | <https://maven.mozilla.org/maven2/>（只在 Mozilla 自家仓库发布） |
| 许可 | Mozilla Public License 2.0（MPL-2.0），<http://mozilla.org/MPL/2.0/> |
| 上游源码 | <https://hg.mozilla.org/releases/mozilla-release>，对应 revision `38b9888273f81488e7b45457790717820815e1d2`（取自该版本 POM 的 `<scm><tag>`）；只读镜像 <https://github.com/mozilla/gecko-dev> |
| 文档 | <https://mozilla.github.io/geckoview/>、<https://geckoview.dev> |

本项目**未修改** GeckoView 的 AAR 或原生库，只按 CPU 架构选其中一个 flavor
原样打包。依 MPL-2.0 第 3.2 节，Covered Software 的源码可从上述上游仓库按
revision 获取；许可全文见 <https://www.mozilla.org/en-US/MPL/2.0/>。
MPL-2.0 是文件级弱 copyleft：GeckoView 自身文件继续适用 MPL-2.0，本项目单独
编写的 Kotlin / JS 文件仍适用 MIT，两者不冲突；若修改 GeckoView 后重新分发，
须按 MPL-2.0 公开被修改文件的源码。

## 传递依赖

GeckoView AAR 的 POM 还声明了运行时依赖：Kotlin stdlib 1.9.24、AndroidX
（annotation / collection / core / lifecycle）、`geckoview-exoplayer2`、
SnakeYAML 2.2、`play-services-fido` 21.1.0 等。它们以各自发布仓库随包的许可
为准；用下面命令可列出本地实际解析到的完整依赖树：

```bash
./gradlew :app:dependencies --configuration v7aReleaseRuntimeClasspath
```

本项目没有额外引入任何依赖，也不含广告、统计、崩溃上报或分析 SDK。

## 仅构建期使用的工具

Gradle、Android Gradle Plugin、Android SDK / Build Tools 只在构建时参与，
不打进 APK，许可分别见各自发行方。仓库为国内构建体验默认配置了腾讯云
（Gradle 发行包）与阿里云（Maven）镜像，回退源与更换方式见 CONTRIBUTING.md「本地构建」。

## 新增第三方组件时

请同步更新本文件：组件名、准确版本、许可名称与链接、源码获取方式，
并确认该许可允许以 APK 形式再分发（copyleft / 专利条款尤其要看清）。
