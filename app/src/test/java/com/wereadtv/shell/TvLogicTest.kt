package com.wereadtv.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 纯 JVM 单测：不需要电视、不需要 Android framework。
 * 覆盖最容易改错且过去只能靠真机 logcat 验证的三块规则。
 */
class TvLogicTest {

    @Test
    fun urlClassification() {
        assertEquals(Page.HOME, SiteRules.classify(null))
        assertEquals(Page.HOME, SiteRules.classify("https://weread.qq.com"))
        assertEquals(Page.HOME, SiteRules.classify("https://example.com/other"))
        assertEquals(Page.SHELF, SiteRules.classify("https://weread.qq.com/web/shelf"))
        assertEquals(Page.READER, SiteRules.classify("https://weread.qq.com/web/reader/"))
        assertEquals(Page.READER, SiteRules.classify("https://weread.qq.com/web/reader/abc?k=1"))
    }

    @Test
    fun readingPageDetection() {
        assertTrue(SiteRules.isReading("https://weread.qq.com/web/reader/abc"))
        assertFalse(SiteRules.isReading("https://weread.qq.com/web/shelf"))
        assertFalse(SiteRules.isReading(null))
    }

    @Test
    fun menuWalksDownTheTemporaryStack() {
        assertEquals(Mode.FREE, ModeStack.onMenu(Mode.BOOKS))
        assertEquals(Mode.FREE, ModeStack.onMenu(Mode.READ))
        assertEquals(Mode.FREE, ModeStack.onMenu(Mode.FOCUS))
        assertEquals(Mode.SCROLL, ModeStack.onMenu(Mode.FREE))
        // 最深一层重复按菜单键：既不重入，也不能误退回 FREE
        assertEquals(Mode.SCROLL, ModeStack.onMenu(Mode.SCROLL))
    }

    @Test
    fun backWalksUpExactlyOneLayer() {
        assertEquals(Mode.FREE, ModeStack.onBack(Mode.SCROLL, reading = true))
        assertEquals(Mode.FREE, ModeStack.onBack(Mode.SCROLL, reading = false))
        assertEquals(Mode.BOOKS, ModeStack.onBack(Mode.FREE, reading = false))
        assertEquals(Mode.READ, ModeStack.onBack(Mode.FREE, reading = true))
        assertEquals(Mode.READ, ModeStack.onBack(Mode.FOCUS, reading = true))
        // null = 没有临时态可退，交给关弹窗 / 页面导航 / finish
        assertNull(ModeStack.onBack(Mode.FOCUS, reading = false))
        assertNull(ModeStack.onBack(Mode.READ, reading = true))
        assertNull(ModeStack.onBack(Mode.BOOKS, reading = false))
    }

    @Test
    fun pageSwitchResetsTemporaryModes() {
        assertEquals(Mode.READ, ModeStack.resetFor(reading = true))
        assertEquals(Mode.BOOKS, ModeStack.resetFor(reading = false))
    }

    @Test
    fun panelClosesBeforeLeavingTemporaryModes() {
        // 阅读页开着弹层：自由光标 / 焦点 / 阅读模式都先关弹层，不动模式
        assertTrue(BackRule.closePanelFirst(Mode.FREE, reading = true, panelOpen = true))
        assertTrue(BackRule.closePanelFirst(Mode.FOCUS, reading = true, panelOpen = true))
        assertTrue(BackRule.closePanelFirst(Mode.READ, reading = true, panelOpen = true))
        // 滚动模式优先级最高：先退回自由光标
        assertFalse(BackRule.closePanelFirst(Mode.SCROLL, reading = true, panelOpen = true))
        // 没弹层就按原逻辑退模式
        assertFalse(BackRule.closePanelFirst(Mode.FREE, reading = true, panelOpen = false))
        // 阅读页之外不看弹层：首页登录弹窗另有处理
        assertFalse(BackRule.closePanelFirst(Mode.BOOKS, reading = false, panelOpen = true))
        assertFalse(BackRule.closePanelFirst(Mode.FREE, reading = false, panelOpen = true))
    }

    @Test
    fun jsModeMapping() {
        assertEquals("read", ModeStack.jsMode(Mode.READ, reading = true))
        assertEquals("focus", ModeStack.jsMode(Mode.FOCUS, reading = true))
        assertEquals("cursor", ModeStack.jsMode(Mode.FREE, reading = true))
        assertEquals("cursor", ModeStack.jsMode(Mode.SCROLL, reading = false))
        assertEquals("books", ModeStack.jsMode(Mode.BOOKS, reading = false))
        assertEquals("books", ModeStack.jsMode(Mode.READ, reading = false))
    }

    @Test
    fun scrollSinglePressUsesSmallStep() {
        val (pace, step) = ScrollSteps.next(ScrollPace(), now = 10_000L, repeatCount = 0)
        assertEquals(72, step)
        assertEquals(0, pace.streak)
        assertEquals(10_000L, pace.lastAt)
    }

    @Test
    fun scrollStreakAcceleratesThenCaps() {
        var pace = ScrollPace()
        var now = 10_000L
        val steps = mutableListOf<Int>()
        repeat(6) {
            val result = ScrollSteps.next(pace, now, 0)
            pace = result.first
            steps += result.second
            now += 200L                     // 电视遥控器实测连按间隔可达 800ms
        }
        assertEquals(listOf(72, 120, 168, 216, 216, 216), steps)
        assertEquals(ScrollSteps.MAX_STREAK, pace.streak)
    }

    @Test
    fun scrollStreakResetsAfterPause() {
        var pace = ScrollPace()
        var now = 10_000L
        repeat(4) {
            pace = ScrollSteps.next(pace, now, 0).first
            now += 200L
        }
        assertEquals(ScrollSteps.MAX_STREAK, pace.streak)

        val base = pace.lastAt
        val afterShortGap = ScrollSteps.next(pace, base + ScrollSteps.STREAK_MS - 1, 0)
        assertEquals(216, afterShortGap.second)

        val afterPause = ScrollSteps.next(pace, base + ScrollSteps.STREAK_MS, 0)
        assertEquals(72, afterPause.second)
        assertEquals(0, afterPause.first.streak)
    }

    @Test
    fun keyRepeatAlwaysCountsAsContinuous() {
        // 长按 repeat 不受时间窗口影响：即使上一次是很久以前，也算连按
        val (_, step) = ScrollSteps.next(ScrollPace(), now = 100_000L, repeatCount = 1)
        assertEquals(120, step)
    }
}
