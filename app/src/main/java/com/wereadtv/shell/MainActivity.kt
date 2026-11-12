package com.wereadtv.shell

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONObject
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebExtension

/**
 * WeReadTV —— GeckoView 壳。
 *
 * 为什么换引擎：电视系统 WebView 是 Chromium 74（2019），微信读书 2026-11 起的阅读器
 * 用 WebAssembly（bulk-memory，需 Chrome 75+）做渲染哈希，老 WebView 直接
 * 「加载失败，请点击重试」。系统 WebView 只认小米签名的 com.android.webview，
 * 无 root 不能替换 —— 所以把 GeckoView（Firefox 同款引擎，自带全部现代 Web 能力）
 * 打包进壳里，不再依赖系统 WebView。
 *
 * 注入方式（外壳优先原则）：tv.js 不再用 evaluateJavascript 手动注入，而是由
 * 扩展 background 用 contentScripts.register（document_start）动态注册；脚本内容
 * 来自 App 外部私有目录的 tv.js，改它只需 adb push + 重启，不用重新打包。
 * 按键命令通过 native messaging 端口下发。网站内部逻辑零侵入（除 viewport 与四列那几条 CSS）。
 */
class MainActivity : Activity() {

    /* 模式体系（FREE 全页面可用，不跨页面保持）：
     * READ  阅读页默认。方向键只翻页，不碰焦点；OK 进焦点模式，菜单键进光标模式。
     * FOCUS 焦点导航（仅阅读页）。方向键在工具栏/顶栏间移动橙框，OK 点击，返回键回 READ。
     * BOOKS 浏览页（首页/书架）默认。方向键焦点导航，OK 点击。
     *
     * 临时态是两级栈，菜单键只进、返回键只退，一次一层：
     *   常规(BOOKS/READ/FOCUS) --菜单--> FREE --菜单--> SCROLL
     *   常规(BOOKS/READ/FOCUS) <--返回-- FREE <--返回-- SCROLL
     * FREE  自由光标。方向键移动模拟鼠标，OK 注入真实触摸；菜单键进滚动模式。
     * SCROLL 滚动模式。光标停在原地，方向键四向滚动页面，OK 仍在光标处点击。
     * 两种临时态都不跨页面保持：跳转新页面后自动复位为该页默认模式。 */
    /* Mode / Page 与纯逻辑都拆到 TvLogic.kt，便于 JVM 单测覆盖状态机 */
    private lateinit var runtime: GeckoRuntime
    private lateinit var session: GeckoSession
    private lateinit var gv: GeckoView
    private var port: WebExtension.Port? = null
    private var bgPort: WebExtension.Port? = null
    private val pendingToJs = mutableListOf<JSONObject>()
    private var homeLoaded = false
    private val homeFallback = Runnable { loadHome() }

    /** tv.js 的唯一运行时真源：外部私有目录，adb push 可直写、无需 root */
    private val tvScriptFile: java.io.File by lazy {
        java.io.File(getExternalFilesDir(null), "tv.js")
    }

    private var currentUrl: String? = null
    private var mode = Mode.BOOKS
    private var page = Page.HOME
    private var lastBrowseUrl: String = SiteRules.HOME
    private var modalOpen = false
    private var lastReconcileUrl: String? = null
    private var lastMoveAt = 0L
    private var lastFlipAt = 0L
    private var scrollPace = ScrollPace()
    private var okLongFired = false
    private var toast: Toast? = null
    private var pendingTapUp: Runnable? = null
    private var pendingUpEvent: MotionEvent? = null

    /* JS 上报的点击点逻辑坐标 [x, y, innerWidth]：
       cursor = 自由光标位置；focus = 焦点元素中心；close = 关当前弹层要点的位置
       （有返回箭头的面板给返回键，没有的给关闭键或遮罩空白处）。
       各模式 OK 键统一由壳层注入真实触摸（isTrusted），合成事件过不了页面的反自动化守卫 */
    private var cursorPt: FloatArray? = null
    private var focusPt: FloatArray? = null
    private var closePt: FloatArray? = null

    companion object {
        private const val TAG = "WeReadTV"
        private const val FLIP_COOLDOWN_MS = 110L
        private const val MOVE_COOLDOWN_MS = 90L
        private const val CURSOR_STEP_SMALL = 14     // 光标单按微调步长
        private const val CURSOR_STEP = 40           // 光标长按连发步长（加速）
        private const val OK_LONG_REPEATS = 6        // OK 长按判定：第 6 次 repeat（~800ms）进光标
        private const val PREV_KEY = "ArrowLeft"
        private const val PREV_CODE = 37
        private const val NEXT_KEY = "ArrowRight"
        private const val NEXT_CODE = 39
    }

    /** 仅调试构建输出日志；release 由 BuildConfig.DEBUG 门控，避免刷屏 */
    private fun logD(msg: String) {
        if (BuildConfig.DEBUG) Log.d(TAG, msg)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val settings = GeckoRuntimeSettings.Builder()
            // 仅调试构建开启：网页 console 进 logcat + USB 连 Firefox about:debugging 查页面。
            // 发布版关闭，避免日志刷屏与暴露远程调试 socket。
            .consoleOutput(BuildConfig.DEBUG)
            .remoteDebuggingEnabled(BuildConfig.DEBUG)
            // 全站缩放方案：DESKTOP 视口宽 980 → 1440。站点按 1440 排版
            // 原生出四列/阅读页双页，整体缩到 0.667 铺满 960×540。
            // 旧 WebView 版靠 meta viewport 注入，Gecko 的 MVM 会把它重置掉，
            // 这个 pref 是引擎启动参数，页面碰不到、也不会被站点改掉。
            .configFilePath(installGvConfig())
            .build()
        runtime = GeckoRuntime.create(this, settings)

        session = GeckoSession(
            GeckoSessionSettings.Builder()
                .usePrivateMode(false)
                // 实测 Gecko 128 的 MOBILE 模式有坑：启动时尊重 meta width=1440，
                // 但页面激活几秒后 MVM 自动把布局宽重置回 960（meta 未变，
                // 改写 meta 也唤不回，真机日志 [tv] vp fight-back 循环佐证）。
                // DESKTOP 模式忽略 meta，布局宽由 browser.viewport.desktopWidth
                // pref 控制（gvconfig.yaml 设为 1440），稳定不被重置。
                .viewportMode(GeckoSessionSettings.VIEWPORT_MODE_DESKTOP)
                .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP)
                .build()
        )

        session.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onLocationChange(
                session: GeckoSession,
                url: String?,
                permissions: MutableList<GeckoSession.PermissionDelegate.ContentPermission>,
                hasUserGesture: Boolean
            ) {
                currentUrl = url
                trackBrowseUrl(url)
                syncMode()
            }
        }

        // content script 加不进已经开始加载的文档，所以首页必须等 background
        // 把外置 tv.js 注册完（ready）再 loadUri；8 秒兜底只防注册失败时白屏。
        // navigationDelegate + MutationObserver 仍负责后续页面切换的模式对齐。
        installTvScript()
        session.open(runtime)
        registerExtension()

        gv = GeckoView(this)
        gv.setSession(session)
        setContentView(
            FrameLayout(this).apply {
                setBackgroundColor(android.graphics.Color.WHITE)
                addView(gv, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        )
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.WHITE))
        gv.requestFocus()
        window.decorView.postDelayed(homeFallback, 8000)
    }

    /** 注册打包在 assets 里的扩展：content script 注入 + native messaging 端口 */
    /** 把 assets 里的 GeckoView 启动配置拷到私有目录（configFilePath 要求真实文件路径），
     *  返回文件路径。内容见 gvconfig.yaml：browser.viewport.desktopWidth=1440。 */
    private fun installGvConfig(): String {
        val out = java.io.File(filesDir, "gvconfig.yaml")
        assets.open("gvconfig.yaml").use { input ->
            out.outputStream().use { input.copyTo(it) }
        }
        return out.absolutePath
    }

    /** 首次启动把 APK 内的 tv.js 拷到外部私有目录当出厂种子；之后这个文件
     *  就是唯一真源，assets 里那份运行时不再读（改它请重新打包）。 */
    private fun installTvScript() {
        if (tvScriptFile.exists()) return
        assets.open("extension/tv.js").use { input ->
            tvScriptFile.outputStream().use { input.copyTo(it) }
        }
    }

    /** 等外置脚本注册完再加载首页；兜底先跑过的话，ready 到达时改为 reload。 */
    private fun loadHome() {
        if (homeLoaded) return
        homeLoaded = true
        window.decorView.removeCallbacks(homeFallback)
        session.loadUri(SiteRules.HOME)
    }

    private fun registerExtension() {
        runtime.webExtensionController
            .installBuiltIn("resource://android/assets/extension/")
            .accept(
                { ext ->
                    // WebExtensionController 要求 UI 线程，而 GeckoResult 回调的
                    // 派发线程由引擎决定；显式切回主线程（当前已是则立即执行）。
                    runOnUiThread {
                        if (ext != null) {
                            // 关键：content script 的 delegate 必须注册到 session 级
                            // SessionController（内部路由按 session 查 delegate，
                            // 全局注册时 session=null，onConnect 永远不触发，真机实测）。
                            session.webExtensionController
                                .setMessageDelegate(ext, messageDelegate, "weread_tv")
                            // background 不关联 session，它的端口走全局 delegate。
                            ext.setMessageDelegate(bgDelegate, "weread_tv_bg")
                        }
                        logD("extension registered: ${ext?.id}")
                    }
                },
                { err -> logD("extension register FAIL: $err") }
            )
    }

    /** background 的端口与 content script 的端口分开：前者只负责注册脚本，
     *  后者才是按键命令的接收方，不能互相覆盖 port。 */
    private val bgDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(p: WebExtension.Port) {
            bgPort = p
            p.setDelegate(bgPortDelegate)
            logD("bg port connected")
        }
    }

    private val bgPortDelegate = object : WebExtension.PortDelegate {
        override fun onPortMessage(message: Any, p: WebExtension.Port) {
            if (message !is JSONObject) return
            when (message.optString("ev")) {
                "needScript" -> {
                    p.postMessage(JSONObject()
                        .put("op", "script")
                        .put("src", tvScriptFile.readText()))
                    logD("tv.js sent (${tvScriptFile.length()} bytes)")
                }
                "ready" -> {
                    logD("tv.js registered, homeLoaded=$homeLoaded")
                    if (homeLoaded) session.reload() else loadHome()
                }
                "scriptError" -> logD("tv.js register FAIL: ${message.optString("error")}")
            }
        }

        override fun onDisconnect(p: WebExtension.Port) {
            logD("bg port disconnected")
            if (bgPort === p) bgPort = null
        }
    }

    private val messageDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(p: WebExtension.Port) {
            port = p
            p.setDelegate(portDelegate)
            logD("port connected")
            // 连接建立后把积压的命令一次性补发，并对齐当前模式
            pendingToJs.forEach { postToPort(it) }
            pendingToJs.clear()
            syncMode()
        }
    }

    private val portDelegate = object : WebExtension.PortDelegate {
        override fun onPortMessage(message: Any, p: WebExtension.Port) {
            if (message !is JSONObject) return
            when (message.optString("ev")) {
                "modal" -> {
                    modalOpen = message.optBoolean("open", false)
                    logD("modal=$modalOpen")
                }
                "point" -> {
                    val x = message.optDouble("x", 0.0).toFloat()
                    val pt = floatArrayOf(
                        x,
                        message.optDouble("y", 0.0).toFloat(),
                        message.optDouble("w", 1440.0).toFloat())
                    when (message.optString("kind")) {
                        "cursor" -> cursorPt = pt
                        // x < 0 = 弹层已关，别留旧坐标给下一次返回键
                        "close" -> closePt = if (x < 0) null else pt
                        else -> focusPt = pt
                    }
                }
                else -> logD("js: $message")
            }
        }

        override fun onDisconnect(p: WebExtension.Port) {
            logD("port disconnected")
            if (port === p) port = null
        }
    }

    /** 壳 → JS。端口未连上时先积压，onConnect 后补发 */
    private fun postToPort(obj: JSONObject) {
        try {
            port?.postMessage(obj)
        } catch (e: Exception) {
            logD("postMessage fail: $e")
        }
    }

    private fun sendToJs(obj: JSONObject) {
        if (port == null && pendingToJs.size < 32) pendingToJs.add(obj)
        postToPort(obj)
    }

    private fun jsCommand(op: String, vararg kv: Pair<String, String>): JSONObject {
        val o = JSONObject()
        o.put("op", op)
        kv.forEach { o.put(it.first, it.second) }
        return o
    }

    private fun isReadingPage() = SiteRules.isReading(currentUrl)

    private fun trackBrowseUrl(url: String?) {
        if (url == null || !url.startsWith("http")) return
        page = SiteRules.classify(url)
        if (!SiteRules.isReading(url)) lastBrowseUrl = url
        logD("page=$page lastBrowse=$lastBrowseUrl url=$url")
    }

    /** 页面切换（URL 变化）时复位模式：阅读页 → READ，浏览页 → BOOKS。
     *  自由光标是兜底态，不跨页面保持：
     *  光标点开链接跳页后，新页面回到该页的默认模式 */
    private fun reconcile(url: String? = currentUrl) {
        if (url != lastReconcileUrl) {
            lastReconcileUrl = url
            mode = ModeStack.resetFor(SiteRules.isReading(url))
        }
    }

    private fun syncMode() {
        reconcile()
        sendToJs(jsCommand("mode", "mode" to ModeStack.jsMode(mode, isReadingPage())))
    }

    private fun isDpad(key: Int) = key == KeyEvent.KEYCODE_DPAD_UP ||
            key == KeyEvent.KEYCODE_DPAD_DOWN ||
            key == KeyEvent.KEYCODE_DPAD_LEFT ||
            key == KeyEvent.KEYCODE_DPAD_RIGHT

    private fun isOkKey(key: Int) = key == KeyEvent.KEYCODE_DPAD_CENTER ||
            key == KeyEvent.KEYCODE_ENTER ||
            key == KeyEvent.KEYCODE_NUMPAD_ENTER ||
            key == KeyEvent.KEYCODE_BUTTON_A

    private fun isMenuKey(key: Int) = key == KeyEvent.KEYCODE_MENU

    /**
     * OK 键处理：短按执行 action，长按进自由光标模式。
     * 很多电视遥控器没有菜单键，长按 OK 是光标模式的通用替代入口。
     * 长按判定（两条任一满足）：① DOWN 带 FLAG_LONG_PRESS（adb --longpress
     * 也可测）；② key repeat 第 OK_LONG_REPEATS 次（真实遥控器长按必产生
     * 连发，~800ms）。动作延迟到抬起（ACTION_UP）触发以区分长短按，
     * 短按间隔 <100ms 无感知差异；FREE / SCROLL 内不走这里（OK 直接注触摸）。
     */
    private fun handleOk(event: KeyEvent, action: () -> Unit) {
        when (event.action) {
            KeyEvent.ACTION_DOWN -> {
                /* FLAG_LONG_PRESS 由系统在长按超时后的首个 repeat 事件上置位
                   （真机实测 flg=128 出现在 rep=1），repeatCount 兜底兼容
                   不打该标志的 ROM */
                if (!okLongFired &&
                    (event.flags and KeyEvent.FLAG_LONG_PRESS != 0 ||
                     event.repeatCount >= OK_LONG_REPEATS)) {
                    okLongFired = true
                    enterFree()
                }
            }
            KeyEvent.ACTION_UP -> {
                val consumed = okLongFired
                okLongFired = false
                if (!consumed) action()
            }
        }
    }

    private fun enterFree() {
        logD("mode=FREE")
        mode = Mode.FREE
        syncMode()
        showHint(hintFor(Mode.FREE))
    }

    private fun hintFor(m: Mode): String = getString(when (m) {
        Mode.FREE -> R.string.hint_free
        Mode.SCROLL -> R.string.hint_scroll
        Mode.READ -> R.string.hint_read
        Mode.BOOKS -> R.string.hint_books
        Mode.FOCUS -> R.string.hint_focus
    })

    /** 只在 FREE 下调：菜单键沿临时态栈再进一层；SCROLL 下不会再调，避免重复进入 */
    private fun enterScroll() {
        logD("mode=SCROLL")
        mode = Mode.SCROLL
        syncMode()
        showHint(hintFor(Mode.SCROLL))
    }

    /**
     * 返回键：阅读页弹层 → 临时态栈 → 关弹窗 / 页面导航 / finish。
     * 优先级见 BackRule。
     */
    private fun handleBack() {
        /* 阅读页弹层（目录/书评/字体/AI/笔记…）：JS 已把「开着」和「该点哪儿」
           同步过来，这里按坐标注入真实触摸关掉它。面板里的按钮有 isTrusted 守卫，
           合成点击无效；有返回箭头的面板点返回，没有的点关闭/遮罩 */
        if (BackRule.closePanelFirst(mode, isReadingPage(), modalOpen)) {
            logD("BACK close panel pt=${closePt?.joinToString()}")
            if (closePt != null) injectTap(closePt) else sendToJs(jsCommand("closeModal"))
            return
        }
        /* 临时态栈：每次返回只退一层，退出 SCROLL 不会顺带退出 FREE；
           null = 没有临时态可退，继续走关弹窗 / 页面导航 / finish */
        val back = ModeStack.onBack(mode, isReadingPage())
        if (back != null) {
            mode = back
            syncMode()
            showHint(hintFor(back))
            return
        }
        val kind = page
        logD("BACK kind=$kind webUrl=$currentUrl")
        if (kind == Page.HOME) {
            if (modalOpen) {
                sendToJs(jsCommand("closeModal"))
                modalOpen = false
            } else {
                finish()
            }
            return
        }
        val target = if (kind == Page.READER) lastBrowseUrl else SiteRules.HOME
        page = SiteRules.classify(target)
        sendToJs(jsCommand("closeModal"))
        logD("BACK nav -> $target")
        session.loadUri(target)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val key = event.keyCode
        reconcile()
        val down = event.action == KeyEvent.ACTION_DOWN
        val reading = isReadingPage()

        if (key == KeyEvent.KEYCODE_BACK) {
            if (down) handleBack()
            return true
        }

        /* 菜单键：沿临时态栈逐层深入（所有页面统一入口）。
           SCROLL 下直接消费：既不重复进入，也不误退回 FREE（退出统一交给返回键） */
        if (isMenuKey(key)) {
            if (down) {
                val next = ModeStack.onMenu(mode)
                if (next == mode) showHint(hintFor(Mode.SCROLL))   // 已在最深层：不重入，也不误退
                else if (next == Mode.FREE) enterFree()
                else enterScroll()
            }
            return true
        }

        /* 滚动模式：光标停在原地，方向键四向滚动，OK 仍在光标处点击 */
        if (mode == Mode.SCROLL) {
            when {
                isDpad(key) -> {
                    if (down && allowMove()) {
                        sendDirCommand("scroll", key, "step" to scrollStep(event).toString())
                    }
                    return true
                }
                isOkKey(key) -> {
                    // 只认首次 DOWN：长按 repeat 不连发点击
                    if (down && event.repeatCount == 0) injectTap(cursorPt)
                    return true
                }
            }
            return super.dispatchKeyEvent(event)
        }

        /* 自由光标模式（全页面）：方向键移动模拟鼠标，OK 注入真实触摸点击 */
        if (mode == Mode.FREE) {
            when {
                isDpad(key) -> {
                    if (down && allowMove()) {
                        // 单按小步微调，长按 repeat 连发走大步
                        val st = if (event.repeatCount > 0) CURSOR_STEP else CURSOR_STEP_SMALL
                        val d = when (key) {
                            KeyEvent.KEYCODE_DPAD_UP -> 0 to -st
                            KeyEvent.KEYCODE_DPAD_DOWN -> 0 to st
                            KeyEvent.KEYCODE_DPAD_LEFT -> -st to 0
                            else -> st to 0
                        }
                        sendToJs(jsCommand("cursorMove", "dx" to d.first.toString(), "dy" to d.second.toString()))
                    }
                    return true
                }
                isOkKey(key) -> {
                    /* 长按 OK 进 FREE 后，这次按键的 UP 落在本分支而不是 handleOk，
                       所以标记得在这里清：否则退出 FREE 后第一次短按 OK 会被
                       handleOk 当成「长按已消费」吞掉。这次抬起也不算点击。 */
                    if (!down && okLongFired) {
                        okLongFired = false
                        return true
                    }
                    // 只认首次 DOWN：长按 repeat 不连发触摸（与 SCROLL 一致）
                    if (down && event.repeatCount == 0) injectTap(cursorPt)
                    return true
                }
            }
            return super.dispatchKeyEvent(event)
        }

        /* 焦点模式：方向键在右侧工具栏/顶栏间移动橙框，OK 点击（真实触摸），
           返回键回阅读模式 */
        if (reading && mode == Mode.FOCUS) {
            when {
                isDpad(key) -> {
                    if (down && allowMove()) sendDirCommand("move", key)
                    return true
                }
                isOkKey(key) -> {
                    handleOk(event) {
                        if (focusPt != null) injectTap(focusPt)
                        else sendToJs(jsCommand("ok"))   // 无坐标上报时的兜底
                    }
                    return true
                }
            }
            return super.dispatchKeyEvent(event)
        }

        /* 阅读模式（默认进入）：方向键全部翻页（↑/→ 下一页，↓/← 上一页，
           统一合成 ArrowLeft/ArrowRight，页面键盘监听只认这两个）；
           OK 进入焦点模式；菜单键进入光标模式 */
        if (reading && mode == Mode.READ) {
            when {
                isDpad(key) -> {
                    if (down) flip(key)
                    return true
                }
                isOkKey(key) -> {
                    handleOk(event) {
                        mode = Mode.FOCUS
                        syncMode()
                        showHint(hintFor(Mode.FOCUS))
                    }
                    return true
                }
            }
            return super.dispatchKeyEvent(event)
        }

        /* 浏览页（首页/书架）默认：方向键焦点导航，OK 点击；长按 OK 进光标。
           和阅读页焦点模式一样走壳层真实触摸：首页「换一批」等控件带
           isTrusted 守卫，JS 合成点击（activate 里的 el.click()）无效。
           focusPt 由 setFocus() 的 reportPoint('focus') 上报；为空时 injectTap
           自行兜底回退到合成事件，无需此处再加判断。 */
        if (isDpad(key)) {
            if (down && allowMove()) sendDirCommand("move", key)
            return true
        }
        if (isOkKey(key)) {
            handleOk(event) { injectTap(focusPt) }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun allowMove(): Boolean {
        val now = SystemClock.uptimeMillis()
        if (now - lastMoveAt < MOVE_COOLDOWN_MS) return false
        lastMoveAt = now
        return true
    }

    /** 方向键 → 方向名；move（焦点导航）与 scroll（滚动模式）共用同一套映射。
     *  scroll 额外带 step：步长由壳侧算，JS 只负责按这个幅度滚 */
    private fun sendDirCommand(op: String, key: Int, vararg extra: Pair<String, String>) {
        val dir = when (key) {
            KeyEvent.KEYCODE_DPAD_UP -> "up"
            KeyEvent.KEYCODE_DPAD_DOWN -> "down"
            KeyEvent.KEYCODE_DPAD_LEFT -> "left"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
            else -> return
        }
        val cmd = jsCommand(op, "dir" to dir)
        extra.forEach { cmd.put(it.first, it.second) }
        sendToJs(cmd)
    }

    /** 步长计算交给纯函数 ScrollSteps.next，本方法只负责存取状态 */
    private fun scrollStep(event: KeyEvent): Int {
        val (next, step) = ScrollSteps.next(scrollPace, SystemClock.uptimeMillis(), event.repeatCount)
        scrollPace = next
        return step
    }

    private fun flip(key: Int) {
        val now = SystemClock.uptimeMillis()
        if (now - lastFlipAt < FLIP_COOLDOWN_MS) return
        lastFlipAt = now
        val next = key == KeyEvent.KEYCODE_DPAD_RIGHT || key == KeyEvent.KEYCODE_DPAD_DOWN
        val keyName = if (next) NEXT_KEY else PREV_KEY
        val code = if (next) NEXT_CODE else PREV_CODE
        sendToJs(jsCommand("key", "key" to keyName, "code" to code.toString()))
    }

    /**
     * 在逻辑坐标 pt=[x,y,innerWidth] 处注入真实触摸（ACTION_DOWN → 60ms →
     * ACTION_UP），走 PanZoomController 官方输入管线，页面收到 isTrusted=true
     * 的完整点击事件。阅读页工具栏/面板有 isTrusted 守卫（反自动化），
     * JS 合成事件一律无效，只有这条真路能点得动。
     * 逻辑坐标 → 视图像素：view 宽 / innerWidth。
     */
    private fun injectTap(pt: FloatArray?) {
        if (pt == null || gv.width <= 0) {
            sendToJs(jsCommand("cursorClick"))   // 兜底：合成事件（多数场景够用）
            return
        }
        cancelPendingTapUp()   // 连续快速点击：上一条 UP 还没发出就来了新点击
        try {
            val scale = gv.width.toFloat() / pt[2].coerceAtLeast(1f)
            val vx = pt[0] * scale
            val vy = pt[1] * scale
            val now = SystemClock.uptimeMillis()
            val props = MotionEvent.PointerProperties().apply {
                id = 0
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
            val coords = MotionEvent.PointerCoords().apply {
                x = vx; y = vy; pressure = 1f; size = 1f
            }
            val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, 1,
                arrayOf(props), arrayOf(coords), 0, 0, 1f, 1f,
                0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
            try {
                session.panZoomController.onTouchEvent(down)
            } finally {
                down.recycle()
            }
            // UP 要延迟 60ms 发出，期间由 pendingUpEvent 持有；失败路径统一回收
            val up = MotionEvent.obtain(now, now + 60, MotionEvent.ACTION_UP, 1,
                arrayOf(props), arrayOf(coords), 0, 0, 1f, 1f,
                0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
            pendingUpEvent = up
            val sendUp = Runnable {
                try {
                    session.panZoomController.onTouchEvent(up)
                } catch (e: Exception) {
                    logD("tap up fail: $e")
                } finally {
                    up.recycle()
                    if (pendingUpEvent === up) {   // 只清自己，别误清后一次点击的状态
                        pendingUpEvent = null
                        pendingTapUp = null
                    }
                }
            }
            pendingTapUp = sendUp
            window.decorView.postDelayed(sendUp, 60)
            logD("tap $vx,$vy scale=$scale")
        } catch (e: Exception) {
            cancelPendingTapUp()
            logD("tap fail: $e")
            sendToJs(jsCommand("cursorClick"))
        }
    }

    /** 取消并回收尚未发出的 ACTION_UP：onDestroy 与连续点击都要调 */
    private fun cancelPendingTapUp() {
        pendingTapUp?.let { window.decorView.removeCallbacks(it) }
        pendingTapUp = null
        pendingUpEvent?.recycle()
        pendingUpEvent = null
    }

    private fun showHint(text: String) {
        toast?.cancel()
        toast = Toast.makeText(this, text, Toast.LENGTH_SHORT)
        toast?.show()
    }

    override fun onResume() {
        super.onResume()
        gv.requestFocus()
        session.setActive(true)
    }

    override fun onPause() {
        session.setActive(false)
        super.onPause()
    }

    override fun onDestroy() {
        window.decorView.removeCallbacks(homeFallback)
        cancelPendingTapUp()   // 别让延迟的触摸落在已关闭的 session 上
        try {
            session.close()
            runtime.shutdown()
        } catch (e: Exception) {
            logD("shutdown: $e")
        }
        super.onDestroy()
    }
}
