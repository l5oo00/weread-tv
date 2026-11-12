# 参与贡献

欢迎提 Issue 和 PR。讨论请就事论事、友善包容，报告问题附可复现的环境与证据；
不接受人身攻击、公开他人隐私，或发布含登录态 / 个人书架的截图。几点约定：

- **保持功能不变的前提下做清理**：本项目刻意零依赖、单 Activity、单 WebExtension，
  不引入框架或额外依赖。
- **改 `tv.js` 时建议同步递增 `manifest.json` 的 `version`，但不是发布阻断项**：
  内置扩展随 APK 打包，覆盖安装后新脚本照样生效；递增版本只为便于核对实际
  激活版本。实测背景见 [`docs/tech-notes.md`](./docs/tech-notes.md) 第 3 节。
- **提交信息**：用中文、说明「为什么」而非「做了什么」；涉及行为变化的请在 PR 描述里
  写明真机验证情况。
- **提交身份**：提交前确认 `git config user.name` / `user.email` 是能联系到你的身份，
  不要用工具生成的占位符；这也是公开仓库里追溯改动与致谢的依据。
- **真机验证**：核心交互（光标、焦点、翻页、滚动、点击）只在真实电视 / 盒子上可验，
  提交前尽量在真机回归；纯逻辑改动也请说明测试覆盖。
- **分支**：直接往 `main` 提 PR 即可。CI 会先跑 `node --check`、扩展清单 JSON 校验、
  `testV7aDebugUnitTest` 与 `lintV7aDebug`，再构建 v7a / arm64 两个 debug APK 作为
  产物；lint 的两个历史 error 已修（第三方 `NotificationPermission` 误报在
  `build.gradle.kts` 里单独 disable，其余告警保留），新增告警请一并处理，别直接关检查。

## 代码在哪

```
app/src/main/java/com/wereadtv/shell/MainActivity.kt   # 壳：引擎会话、按键状态机
app/src/main/java/com/wereadtv/shell/TvLogic.kt       # 纯 Kotlin 逻辑（模式栈、URL 分类、滚动步长）
app/src/test/java/com/wereadtv/shell/TvLogicTest.kt   # 对应 JVM 单测
app/src/main/assets/extension/tv.js                   # 内容脚本：焦点导航 / 自由光标 / 滚动 / 命中定位
app/src/main/assets/extension/manifest.json           # WebExtension 清单
app/src/main/assets/gvconfig.yaml                     # 引擎启动参数（视口）
```

改 `TvLogic.kt` 的规则时先跑单测，再到真机回归交互手感。

## 本地构建

环境要求：JDK 17、Android SDK（`local.properties` 指定路径）。项目自带
`gradle-wrapper`，clone 后无需预装 Gradle。

```bash
git clone https://github.com/l5oo00/weread-tv.git
cd weread-tv

./gradlew assembleV7aDebug        # 32 位，产物 app/build/outputs/apk/v7a/debug/
./gradlew assembleArm64Debug      # 64 位，产物 app/build/outputs/apk/arm64/debug/

# 纯 JVM 单测（不需要接电视）与 lint，CI 也会跑
./gradlew testV7aDebugUnitTest lintV7aDebug
```

按 CPU 架构分 `v7aDebug` / `arm64Debug` 两个 variant（引擎构件不能同包），
release 同理是 `assembleV7aRelease` / `assembleArm64Release`。

### 依赖镜像

下载默认「国内镜像优先、失败回退官方」：`gradle-wrapper.properties` 的 Gradle
发行包指向腾讯云镜像，`settings.gradle.kts` 里 Gradle 插件与 Maven 依赖优先走
阿里云镜像，找不到时回退 `google()` / `mavenCentral()`；GeckoView 只发布在
`maven.mozilla.org`，因此该仓库始终保留。GitHub Actions 的境外 runner 访问腾讯云
发行包不稳定，CI 会在构建前把 **wrapper 的 `distributionUrl`** 临时切回
`services.gradle.org`（只改 CI 检出的副本，不影响仓库和本地）；Maven 镜像在 CI 里
不切，官方源作为回退仍然可用。想完全走官方源，把这两处镜像行删掉即可。
`gradle-wrapper.properties` 还带官方发行包的 `distributionSha256Sum`，wrapper 会校验
下载到的 zip；腾讯云镜像与官方是同一个文件（SHA-256 已比对一致），本地镜像与
CI 官方源两种路径都能通过校验。

## 构建与发布

debug 包只是开发便利；要分发请出 release 包（关闭了调试日志与远程调试）：

```bash
./gradlew assembleV7aRelease       # 产物 app/build/outputs/apk/v7a/release/
./gradlew assembleArm64Release     # 产物 app/build/outputs/apk/arm64/release/
```

签名：仓库根放一个 `signing.properties`（**已被 .gitignore 忽略，切勿提交**）：

```
STORE_FILE=/绝对路径/your.keystore
STORE_PASSWORD=xxx
KEY_ALIAS=your_alias
KEY_PASSWORD=xxx
```

不提供 `signing.properties` 时，release 会兜底复用本机 `~/.android/debug.keystore`
直接出可装包（仅供自用）。

> **发布签名使用项目专用、离线保管的 release keystore**（不入库）。本地
> `signing.properties` 与仓库 4 个 `ANDROID_*` Secrets 必须指向同一把密钥，
> 证书指纹见 [安全与隐私](./SECURITY.md)。更换密钥会让旧包无法覆盖安装
> （需卸载重装、会丢登录态），因此非必要不更换；确需更换时同步更新
> README、SECURITY.md、`release.yml` 里写死的指纹与发布说明。

本项目不发 Android App Bundle（AAB）：AAB 必须走 Google Play 等商店托管才能安装，
无法直接侧载到电视。面向「下载 apk 侧装」场景，因此按架构出两个独立 APK。

### 打 tag 自动发布

推一个 `v*` 标签会触发 `.github/workflows/release.yml`：构建 v7a / arm64 两个
release APK，附上选包说明并发布到 GitHub Releases，产物名为
`WeReadTV-<tag>-v7a.apk` / `WeReadTV-<tag>-arm64.apk`。

发版顺序建议如下（`main` 上有仓库规则，见下方说明，顺序反了要返工）：

```bash
# 1. 先升 versionCode / versionName，提交
# 2. 推分支开 PR，等 build.yml 变绿
git push origin main:refs/heads/release-x.y.z
gh pr create --base main --head release-x.y.z

# 3. 检查绿了再快进 main（同一 commit 已有通过的检查，规则放行）
git push origin main

# 4. 最后推 tag
git tag -a v0.2.0 -F tag-message.txt      # 注释 tag，发布页标题取自这里
git push origin v0.2.0
```

> `main` 上启用了一条仓库规则（ruleset「保护 main 分支」）：必须 `build` 检查通过
> 才能推送，且连仓库所有者也不能绕过。所以新提交不能直接 `git push origin main`
> —— 会以 `push declined due to repository rule violations` 失败。
>
> tag 不受这条规则约束（tag 有单独的 ruleset，只禁止删除 / 移动已有 tag）。所以
> **先推 tag 也能发布成功**，但 `main` 会落后于 tag，`origin/main` 上看不到发布内容。
> 更隐蔽的是 `push.followTags` 默认开着时，那条失败的 `git push origin main`
> 会顺手把本地 tag 一起推走，当场触发发布流程 —— 于是出现「main 没推上去，
> Release 却已经出包」的现象。

普通 push 只跑 `build.yml`（debug 包上传为 Actions Artifacts，保留 30 天），
不会创建 Release。两个工作流都只给必要权限（`contents: read` / `write`），
第三方 action 全部 pin 到 commit SHA。

发布产物附带 `SHA256SUMS`，并在发布前用 `apksigner verify` 校验每个 APK 的
签名；同名 tag 若已存在 Release，工作流会**直接失败**而不是静默覆盖已发布的
APK。下载后建议校验：

```bash
sha256sum -c SHA256SUMS
apksigner verify --print-certs WeReadTV-<tag>-v7a.apk
```

CI 签名必须读仓库 Secrets：`ANDROID_KEYSTORE_BASE64`（keystore 的 base64）、
`ANDROID_STORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。与本地
装机用同一把密钥时，Release 产物可直接 `adb install -r` 覆盖安装。
**未配置齐这四个 Secrets 时工作流会直接失败**——不允许现场随机生成密钥，
否则同一 tag 重跑就可能产出签名不同的包，用户既无法验包也无法覆盖安装。

## 版本号一览

仓库里有四套版本号，各自作用域不同，别混用：

| 位置 | 例子 | 作用域 | 什么时候改 |
|---|---|---|---|
| `app/build.gradle.kts` `versionCode` | `2` | Android 系统判断能否覆盖安装（必须单调递增） | 每次正式发版 |
| `app/build.gradle.kts` `versionName` | `0.2.0` | 展示给用户的版本、Release tag 名 | 每次正式发版 |
| `extension/manifest.json` `version` | `2.7` | WebExtension 自身版本标识，便于核对激活版本 | 改扩展时建议递增，不强制 |
| `tv.js` 顶部 `V` | `13` | 脚本防重复注入标记，仅本文件内使用 | 改脚本时建议递增，不强制 |

只有前两者决定「用户装到的是哪一版」；后两者是内部标识，不影响 APK 发版。
