package com.wereadtv.shell

/**
 * 不依赖 Android 的纯逻辑：URL 分类、临时态栈、滚动步长。
 *
 * 为什么单独成文件：MainActivity 里的按键行为以前只能在真机上靠 logcat 验证，
 * 而这几块恰恰是最容易改错的规则。抽成纯函数后可用 JVM 单测覆盖
 * （见 app/src/test/.../TvLogicTest.kt），CI 也能在不接电视的情况下拦住回归。
 * 本文件禁止 import android.*，否则单测需要 Robolectric / android.jar mock。
 */

enum class Page { HOME, SHELF, READER }
enum class Mode { BOOKS, READ, FOCUS, FREE, SCROLL }

/** 站点 URL 规则。换站点或前端改路由时只需改这里，Activity 不写死域名。 */
object SiteRules {
    const val HOME = "https://weread.qq.com"
    const val READER_MARK = "/web/reader/"
    const val SHELF_MARK = "/web/shelf"

    fun isReading(url: String?): Boolean = url?.contains(READER_MARK) == true

    /** 未知 URL 一律按首页处理，返回键才会走「关弹窗 / 退出」而不是导航 */
    fun classify(url: String?): Page = when {
        isReading(url) -> Page.READER
        url?.contains(SHELF_MARK) == true -> Page.SHELF
        else -> Page.HOME
    }
}

/**
 * 临时态栈：常规(BOOKS/READ/FOCUS) --菜单--> FREE --菜单--> SCROLL。
 * 菜单键只进、返回键只退，一次一层；返回 null 表示「没有临时态可退」，
 * 由 Activity 继续处理关弹窗 / 页面导航 / finish。
 */
object ModeStack {
    /** 已在最深层时原样返回：既不重复进入，也不误退回 FREE。
     *  调用方用「新旧 mode 相同」判断是否需要提示，无状态变化 */
    fun onMenu(mode: Mode): Mode = when (mode) {
        Mode.BOOKS, Mode.READ, Mode.FOCUS -> Mode.FREE
        Mode.FREE -> Mode.SCROLL
        Mode.SCROLL -> Mode.SCROLL
    }

    fun onBack(mode: Mode, reading: Boolean): Mode? = when (mode) {
        Mode.SCROLL -> Mode.FREE
        Mode.FREE -> if (reading) Mode.READ else Mode.BOOKS
        Mode.FOCUS -> if (reading) Mode.READ else null
        else -> null
    }

    /** 跳转新页面后临时态不跨页保持，回到该页默认模式 */
    fun resetFor(reading: Boolean): Mode = if (reading) Mode.READ else Mode.BOOKS

    /** FREE 与 SCROLL 共用 JS 侧的 'cursor'，区别只在壳把方向键翻译成哪种命令 */
    fun jsMode(mode: Mode, reading: Boolean): String = when {
        reading && mode == Mode.READ -> "read"
        reading && mode == Mode.FOCUS -> "focus"
        reading -> "cursor"
        mode == Mode.FREE || mode == Mode.SCROLL -> "cursor"
        else -> "books"
    }
}

/**
 * 返回键优先级（阅读页）：滚动模式 → 页面弹层 → 临时态栈 → 页面导航。
 *
 * 弹层必须压过「退出自由光标 / 焦点模式」：目录、书评、字体这些面板都是在
 * 光标 / 焦点模式下点开的，如果返回先退模式，面板还留在屏幕上，得重新呼出
 * 光标、再用方向键挪到 X 上才关得掉 —— 这正是要修掉的体验。
 * 滚动模式例外：它是最外层的临时态，先退到自由光标再看弹层。
 * 阅读页之外不看弹层（首页的登录弹窗有它自己的处理）。
 */
object BackRule {
    fun closePanelFirst(mode: Mode, reading: Boolean, panelOpen: Boolean): Boolean =
        panelOpen && reading && mode != Mode.SCROLL
}

/** 连按加速的状态。lastAt 取 SystemClock.uptimeMillis()，由调用方传入以便单测 */
data class ScrollPace(val streak: Int = 0, val lastAt: Long = 0L)

/** 滚动步长：单按小步，连按 / 长按逐级加速，停手 STREAK_MS 后归零 */
object ScrollSteps {
    const val SMALL = 72
    const val INC = 48
    const val MAX_STREAK = 3           // 72 → 120 → 168 → 216
    // 电视遥控器连按间隔实测可达 800ms，窗口太紧会永远触发不了加速
    const val STREAK_MS = 900L

    /** 返回「新状态」与「本次步长」；调用方存回状态即可，纯函数无副作用 */
    fun next(pace: ScrollPace, now: Long, repeatCount: Int): Pair<ScrollPace, Int> {
        val continuous = repeatCount > 0 || now - pace.lastAt < STREAK_MS
        val streak = if (continuous) (pace.streak + 1).coerceAtMost(MAX_STREAK) else 0
        return ScrollPace(streak, now) to (SMALL + streak * INC)
    }
}
