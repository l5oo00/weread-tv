# WeReadTV 技术内幕

> 本文对应当前实现（含滚动模式）。四套版本号的区别见
> [CONTRIBUTING](../CONTRIBUTING.md)。

主 README 介绍是什么、怎么装；这篇记录**为什么长这样**——每个关键决定
背后都有一次真机踩坑。改代码前先读一遍，别把坑重新踩一遍。

## 1. 引擎：为什么是 GeckoView

- 实测用的那台电视（32 位 / 1080p / Android 10，小米系 ROM）自带系统 WebView
  是 Chromium 74（2019），且只认厂商签名的 `com.android.webview`，无 root
  不能替换。微信读书 2026-11 起的阅读器用 WebAssembly（bulk-memory，
  需 Chrome 75+）做渲染校验，这台机器的系统 WebView 直接「加载失败，请点击重试」。
  **这只是该机型的特例，不是所有电视的普遍情况**：其他设备的 WebView 版本与
  可替换性各不相同。
- 因此本项目不依赖设备自带 WebView，而是把 GeckoView（Firefox 同款引擎）
  打包进 APK（约 130MB），自带全部现代 Web 能力，设备差异不影响使用。
- 直接用 `GeckoRuntimeSettings` + `GeckoSession`，单 Activity 单会话。

## 2. 缩放：DESKTOP 视口 + 引擎启动参数

微信读书只认「视口宽度」决定排版（正文是 canvas 画的，CSS 怎么改都没用）。
目标：布局宽 1440 → 阅读页自动左右双页、首页四列，由引擎按设备分辨率缩放显示。

- **MOBILE 模式 + meta viewport 不可靠**：Gecko 128 的 MVM 会在页面激活几秒后
  把布局宽从 1440 重置回 960（当时靠排查期临时加的 `[tv] vp fight-back` 日志
  佐证，该日志现已移除），改写 meta 也唤不回。
- **最终方案**：`GeckoRuntimeSettings.configFilePath` 指向一份
  `gvconfig.yaml`（`browser.viewport.desktopWidth: 1440`）+ `VIEWPORT_MODE_DESKTOP`
  + `USER_AGENT_MODE_DESKTOP`。这是引擎启动参数，页面碰不到、也不会被站点改掉。

## 3. 适配层：内置扩展 + 外置 tv.js 动态注册

- `installBuiltIn("resource://android/assets/extension/")` 注册打包在 assets 里的
  扩展。Gecko 把它解析成 `jar:file:///data/app/<pkg>/base.apk!/assets/...`
  **直接从 APK 读**，不落盘到 profile，所以改应用私有目录碰不到扩展包内文件。
- 因此 `manifest.json` 不再声明 `content_scripts`。改由 `bg.js` 在每次启动时调
  `browser.contentScripts.register({matches, js:[{code}], runAt:'document_start'})`：
  引擎把 `code` 转成 `blob:` URL，走和标准 content script 完全相同的注入管线，
  `document_start` 与 `connectNative` 特权都保留（`FLAG_ALLOW_CONTENT_MESSAGING`
  只看扩展权限 `nativeMessagingFromContent`，与脚本来源无关）。脚本全部内容来自
  `/sdcard/Android/data/com.wereadtv.shell/files/tv.js`，`adb push` 直写、无需 root。
- **改脚本只需两步**：`adb push tv.js /sdcard/Android/data/com.wereadtv.shell/files/tv.js`
  → 重启 App。`register` 注册的是那一刻的代码快照，**只刷新页面不生效**。
  APK 内 `assets/extension/tv.js` 只在首次启动（外部文件不存在时）当出厂种子，
  之后运行时不再读；要换这份种子才需要重新打包。
- **两条 native messaging 端口要分开**：content script 连 `weread_tv`，必须注册到
  session 级 `SessionController`；background 连 `weread_tv_bg`，不关联 session，
  走全局 `ext.setMessageDelegate`。壳侧 `port` 只指向前者（按键命令的接收方）。
- **首页必须等 `ready` 再 `loadUri`**：content script 加不进已经开始加载的文档。
  曾试过「`loadUri` 与注册并行、注册完再 `session.reload()`」，真机上 `ready` 来得
  比首次导航提交还快，`reload()` 把还没提交的导航直接取消了，结果是纯白屏
  （`onLocationChange` 一次都不触发）。现在 `onCreate` 不调 `loadUri`，等 background
  注册完发 `{ev:'ready'}` 再 `loadHome()`；另挂 8 秒兜底，只为 background 起不来时
  别白屏，兜底先跑过时 `ready` 到达改为 `reload()` 补上适配层。
- 后续页面切换靠 `navigationDelegate` 的 `onLocationChange` + `MutationObserver` +
  `hashchange/popstate` 对齐模式；端口未连上时的命令积压在 `pendingToJs` 等 `onConnect` 补发。

**扩展版本**：`manifest.json` 的 `version`（当前 2.9）只是扩展自身标识，
但也是 Gecko startupCache 的键之一，改 manifest 时递增更稳妥。

## 4. 按键状态机（MainActivity.kt / TvLogic.kt）

```
Mode: BOOKS(浏览页默认) / READ(阅读页默认) / FOCUS(阅读页焦点导航)
      FREE(自由光标,全页面) / SCROLL(滚动,全页面)

常规(BOOKS/READ/FOCUS) --菜单键--> FREE --菜单键--> SCROLL
常规(BOOKS/READ/FOCUS) <--返回键-- FREE <--返回键-- SCROLL

菜单键只逐层进入（SCROLL 下重复按只消费、不重入也不误退），
返回键一次只退一层；reconcile() 在 URL 于阅读页/浏览页切换时复位模式，
FREE / SCROLL 都不跨页面保持。
```

**阅读页返回键优先级**（`BackRule.closePanelFirst`）：滚动模式 → 页面弹层 → 模式栈 → 页面导航。
弹层必须压过「退出光标 / 焦点模式」：目录、书评、字体这些面板都是在光标 / 焦点模式下点开的，
返回先退模式的话面板还留在屏幕上，得重新呼出光标再挪到 X 上才关得掉。

弹层由 JS 识别并算出「该点哪儿」随 `{ev:'point',kind:'close'}` 上报（`ev:'modal'` 表示有没有）：
① 可见的 `.reader_float_panel_header_backBtn` → 点返回（书评详情这类子页回列表）；
② 可见的关闭按钮（`_closeBtn` / `search_panel_header_close_wrapper` / `wr_dialog_closeButton`）；
③ 都没有就点 `.wr_mask` 遮罩空白处（站点自己的「点外面关掉」），x 取面板外侧的中点。
**图片放大层**（点正文插图弹出，Viewer.js，`.viewer-container.viewer-backdrop`）没有
返回 / 关闭按钮也不铺 `.wr_mask`，走单独一支：点屏幕四角（内缩 10px）的空白 —— 放大图
居中显示且可拖动，四角逐个检查挑一个不在图上的（先上角后下角，底边偶有标题条）；
全被图盖住（1:1 拉满）就放弃，返回键走 `closeModal` 兜底。点图上是缩放，落点离图至少
留 8px，别把「关掉」变成「放大」。
面板按钮有 isTrusted 守卫，只能靠壳层 `injectTap` 注真实触摸，所以是「上报坐标」而不是 JS 点。
两个状态都**不去重、每次 DOM 变化重发**：漏一次就会退化成合成 `.click()`，面板关不掉（真机踩过）。
**放大层容器自带 tabindex，会被 `muteExcept` 的选择器捞进来**；它关闭后节点不删
（`viewer-hide` 常驻 DOM），隐藏态不算弹层就会被 mute 上，重开就是 pointer-events:none，
点空白 / 返回键注入的点击全部穿透，永远关不掉（真机踩过；自由光标没事是因为
`clearMuted` 全清了）。所以 `muteExcept` 对 `.viewer-container` 整棵子树豁免。

- 阅读页翻页：合成 `ArrowLeft` / `ArrowRight` 键盘事件（页面原生监听）。
  壳侧有 110ms 翻页冷却、90ms 移动冷却防连发过冲。
- **阅读页上下键：不判断横竖屏，直接试滚 + 读回**（`pageVertical`）。站点有两种排版 ——
  分页（横屏双栏，底部有「上一页 / 下一页」）和竖屏长页（整章一张 canvas，文档可滚）。
  做法是滚一屏后立刻读 `scrollTop`：变了就说明是长页、滚动成功；**没变**就当成
  分页排版或已到章末，转成翻页。
  - 为什么不按「文档高度 > 视口高度」去判：那是推断，阈值总得定，横屏下万一有几像素
    溢出就会误判成长页；而且将来站点改版、换排版实现都可能推翻它。
  - 为什么读回后还要判一次：`window.scrollTo` 有可能被站点拦掉（或被
    `scroll-behavior:smooth` 变成动画），此时读回来就是没动，自然落到翻页分支，
    **不会出现「按了没反应」的死角**。判据只依赖引擎自己的行为。
  - `behavior:'instant'` 必须显式写：否则站点若设了 `scroll-behavior:smooth`，
    紧接着读 `scrollTop` 还是旧值，会被自己误判成「没滚动」。
  - 步长用 `clientHeight`（810）而不是 `innerHeight`（902）：后者会滚到 94% 屏，
    行间重叠太少。滚到章末（`target === before`）继续按会发 `ArrowRight` 进下一章。
  - 分页排版下这条分支读回没动 → 发 `ArrowRight` / `ArrowLeft`，与改动前完全一致；
    长按会连发 repeat，JS 侧自带 350ms 节流，别翻页翻飞。
- **`scrollAtCursor` 的 overflow 判断不能省**：只看 `scrollHeight > clientHeight` 会把
  `overflow:visible` 的包裹层也算成可滚，对它 `scrollBy` 完全无效（scrollTop 恒为 0），
  然后 `return` 掉，永远走不到 `window.scrollBy` —— 竖屏长页「滚动模式按了没反应」的根因。
- 自由光标：方向键发 `{op:'cursorMove',dx,dy}`，**壳侧参数全是字符串，
  JS 端必须 `parseInt`**（number+string 会拼成 NaN，光标钉死在屏幕角落）。
  单按 14px 微调、长按 repeat 连发 40px 加速。
- 滚动模式：光标停在原点，方向键改发 `{op:'scroll',dir,step}`，
  OK 仍在光标处点击。JS 侧以光标为锚点**三级互斥**滚动：
  ① 最近的内部可滚动容器 → ② 文档 `window.scrollBy` → ③ 合成 wheel 兜底。
  不能只发 wheel：脚本派发的 `WheelEvent` 不会触发浏览器默认滚动，普通
  `overflow` 容器和文档滚动条根本不动；它只能通知页面
  自己写的 wheel 处理器（canvas 阅读器、虚拟列表属于这类）。反过来只 `scrollBy`
  也覆盖不了没有真实滚动条的区域。三条择一命中即 `return`，避免一次按键
  产生两段位移。另外 `body`/`documentElement` 在标准模式下 `scrollBy` 不接管
  视口，第 ② 级必须走 `window.scrollBy`。
  步长由 `TvLogic.kt` 的 `ScrollSteps.next()` 算（壳侧 `scrollStep()` 只负责存取
  状态）：单按 72 CSS px，连按/长按逐级 120→168→216 封顶，停手 900ms 归零。
  900ms 不是拍脑袋：这台电视上 `input keyevent` 连按间隔实测约 800ms，
  窗口设 450/600ms 时加速一次都触发不了。
- OK 长按：`handleOk` 在长按时 `enterFree()` 并置 `okLongFired`，动作延迟到
  `ACTION_UP` 触发以区分长短按；FREE / SCROLL 内不走它，OK 直接触发点击。
  **注意进 FREE 后同一次按键的 UP 会落在 FREE 分支**，`handleOk` 没机会清标记，
  所以 FREE 分支要自己清 `okLongFired` 并把这次抬起消费掉（不算点击）；
  否则退出 FREE 后第一次短按 OK 会被当成「长按已消费」吞掉。FREE 分支的 OK
  也要只认首次 DOWN，跟 SCROLL 一样，避免长按 repeat 连发点击。
- **双击 OK 会触发 Gecko 的双击缩放**：OK → `injectTap` 是真实触摸，遥控连按两次
  （间隔 ~150ms）在同一个点，APZ 按双击手势把整页放大，再双击缩回。危害有两个：
  遥控没有捏合，放大后只能靠再双击碰运气；页面缩放后壳层按 `innerWidth` 换算的
  点击坐标与画面内容错位（光标指 A、点下去落 B）。
  关它用 `GeckoRuntimeSettings.Builder.doubleTapZoomingEnabled(false)`
  （pref `apz.allow_double_tap_zooming`，runtime 级、全局生效，建 runtime 时设一次）。
  **别去 `PanZoomController` / `GeckoSessionSettings` 里找** —— 这两个类里都没有
  这个开关（`PanZoomController` 只有 `setIsLongpressEnabled`），我第一次就查漏在
  这里，误判成"GeckoView 没有 API"，退而用了 `html,body,* { touch-action:manipulation }`。
  那套 CSS 能用但只是网页侧补丁：要压在站点样式之上，还得靠 `*` 兜住
  "UI 事件行为取命中元素与所有祖先的交集"，站点一旦自己写 `touch-action` 就可能破功。
  **有原生开关就别用 CSS。**
  注：`input keyevent` 连按实测 ~800ms，`input keyevent 23 23` 又是 0ms 间隔
  （第二次 DOWN 会 `cancelPendingTapUp()` 把第一次的 UP 扔掉，只算一次点击），
  **两种 adb 手法都复现不出双击**，只能靠遥控器手按验证。
- **api 对象属性陷阱**：`handleNative` 里必须 `api.setMode(...)`，
  裸调 `setMode(...)` 的 ReferenceError 会被端口监听的 try/catch 静默吞掉
  （曾导致 mode 命令静默失效）。

## 5. 焦点导航与命中定位（tv.js）

- 候选两类：页面自带控件（`.readerControls_item`、顶栏链接等）+ 整块书卡。
  输入框 / 搜索框 / 外链永久排除（`pointer-events:none` + `tabindex=-1`，
  保留显示、只断交互，页面布局不跳）。
- 最近邻空间导航：`得分 = 主轴距离 + 副轴偏离×2`，同向重叠候选免罚 600。
- `inView` 判定用「与视口相交」：要求完全可见会让底边被截断的卡片永远
  进不了焦点，方向键在两张卡之间来回弹。
- 焦点到最底/最顶候选后继续按，改为整页 `scrollBy`（0.8×视口高）——
  书架懒加载就靠这个触发。
- **自由光标命中 `pointTarget()` 两段式**：
  ① `elementsFromPoint` 层叠链自上而下找可交互元素，`closest` 提升到按钮容器；
  ② 几何兜底——部分 UI 被 CSS 设成 `pointer-events:none`，整棵子树从层叠链
  里消失，直接按矩形包含关系搜全部可交互元素、取面积最小的命中块。
- 光标移动途中派发 `mousemove`，React 组件的 hover 高亮能跟着光标走。

## 6. 可调常量

| 位置 | 常量 | 含义 |
|---|---|---|
| MainActivity.kt | `CURSOR_STEP_SMALL` / `CURSOR_STEP` | 光标单按 14 / 长按 40 px |
| TvLogic.kt `ScrollSteps` | `SMALL` / `INC` / `MAX_STREAK` | 滚动单按 72、每级 +48、最多 3 级（封顶 216 CSS px） |
| TvLogic.kt `ScrollSteps` | `STREAK_MS` | 滚动连按判定窗口 900ms，超窗归零 |
| MainActivity.kt | `OK_LONG_REPEATS` | OK 第 6 次 repeat 判定为长按 |
| MainActivity.kt | `FLIP_COOLDOWN_MS` / `MOVE_COOLDOWN_MS` | 翻页 110ms / 移动 90ms 冷却 |
| gvconfig.yaml | `browser.viewport.desktopWidth` | 布局宽 1440（改小字变大，但 CSS 里还有写死的 `25%` / `24px`，不是一处就够） |
| tv.js 顶部 | `V` | 脚本防重复注入标记，仅本文件内使用，与 APK 版本号无关 |

## 7. 调试

日志只在 **debug 包**里有：Kotlin 侧 `logD` 由 `BuildConfig.DEBUG` 门控，
GeckoRuntime 的 `consoleOutput` / `remoteDebuggingEnabled` 同样只在 debug 打开；
内容脚本里已不再保留任何 `console.log`。所以 release 包跑下面这条命令是空的，
属预期行为，不是脚本没加载。需要临时排查时，在 debug 包里加回日志即可，
合入前记得移除。

```bash
adb logcat | grep -E 'WeReadTV'          # 壳侧状态机 / 模式 / 点击
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png
run-as com.wereadtv.shell cat files/mozilla/*/extensions.json  # 扩展激活版本
```

没有日志可看时，验证交互是否生效的替代办法是「按键前后 screencap 做像素差」：
滚动功能就是这样确认的（连按 6 次 DOWN 画面变化 11.15%，
不按键 2 秒的基线仅 0.26%）。

另外两条排查经验：GeckoView 远程调试 socket
（`localabstract:<pkg>/firefox-debugger-socket`）是极简实现，RDP `listTabs`
拿不到 tab；content script 里 hook `addEventListener` 无效（隔离世界，
页面脚本不经过它）。
