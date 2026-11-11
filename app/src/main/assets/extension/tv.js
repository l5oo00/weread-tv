/* WeRead 电视壳 · 页面适配层（零依赖，零新增 UI 组件）
 *
 * 运行形态：本脚本由 GeckoView 以 WebExtension content script
 * （document_start）官方机制加载，不再 evaluateJavascript 注入。
 * 与壳的通信走 native messaging 端口：
 *   JS → 壳：{ev:'modal',open}
 *   壳 → JS：{op:'move',dir} {op:'ok'} {op:'key',key,code} {op:'mode',mode}
 *            {op:'cursorMove',dx,dy} {op:'cursorClick'} {op:'scroll',dir,step}
 *            {op:'closeModal'}
 *
 * 【显示方案：缩放完全归壳，本脚本零布局干预】
 *   微信读书阅读页正文是 JS 画在 canvas 上的，font-size / textZoom / CSS zoom
 *   对它统统无效；网页只认「视口宽度」，据此决定单页还是双页、每页排多少字。
 *   Gecko 128 的 MOBILE 模式 + meta viewport 不可靠（页面激活数秒后 MVM 把
 *   布局宽从 1440 重置回 960，改写 meta 也唤不回，真机实测）。
 *   最终方案：壳侧 GeckoRuntime 配置 prefs: browser.viewport.desktopWidth=1440
 *   （assets/gvconfig.yaml → filesDir → GeckoRuntimeSettings.configFilePath），
 *   VIEWPORT_MODE_DESKTOP 下布局宽固定 1440、整体缩到 960×540（0.667）：
 *     · 全站一套方案，首页/书架/榜单原生四列；
 *     · 阅读页拿到 1440 宽 → 站内自动排左右双页；
 *     · 本文件不再有任何 meta viewport / zoom / transform 操作。
 *   CSS 只保留：焦点橙框、弹窗按钮、继续阅读四列微调、防误触。
 *
 * 【焦点】
 *   - 只聚焦「页面自带控制按钮」和「整块书卡」，输入框/搜索框不可聚焦。
 *   - 首启（还没按过任何键）不显示橙框、不滚动；第一次按方向键或 OK 才点亮。
 *   - 方向键最近邻空间导航；目标不在可视区时才温和滚到最近位置。
 *
 * 对外 API：window.__tv.move('up|down|left|right') / activate() / setMode('books|read|focus|cursor')
 *          / refresh() / state() / closeModal()
 */
(function () {
  'use strict';
  var V = 13;
  if (window.__tv && window.__tv.v === V) { window.__tv.refresh(); return; }

  var BOOK_MIN_W = 90, BOOK_MIN_H = 46;
  var STYLE_ID = '__tv_style';
  var state = {
    mode: 'books',   // 壳连接端口后会立刻发 {op:'mode'} 对齐
    focusEl: null, applying: false, timer: 0,
    userMoved: false, virgin: true
  };

  function isReader() { return location.pathname.indexOf('/web/reader/') >= 0; }

  /* 首页与书架页的登录弹窗是两套 DOM，统一按「可见 + 有尺寸」识别 */
  var MODAL_SELECTORS = '.wr_login_modal_wrapper, .wr_dialog_wrapper, ' +
    '.wr_dialog_container, .login_dialog_container, .login_qrcode_container';
  function visibleModal() {
    var all = document.querySelectorAll(MODAL_SELECTORS), i;
    for (i = 0; i < all.length; i++) {
      var m = all[i], r = m.getBoundingClientRect(), c = getComputedStyle(m);
      if (c.display !== 'none' && c.visibility !== 'hidden' &&
          r.width > 100 && r.height > 100) return m;
    }
    return null;
  }
  function modalOpen() { return !!visibleModal(); }

  /* 把「有没有弹窗」同步告诉 Activity。返回键要在按键当下就决定是关弹窗还是退出，
     不能等 evaluateJavascript 的异步回调（SPA 导航期间回调会延迟数秒）。 */
  var lastModalSent = null;
  function syncModal(open) {
    if (open === lastModalSent) return;
    lastModalSent = open;
    bridgeSend({ ev: 'modal', open: open });
  }

  /* 【不删元素、只断交互】以前把顶栏 / 搜索框 / 热搜整块 display:none，
     还顺手改了页面顶部的 padding —— 页面自己的布局被我们改掉，注入一落地就会
     跳一下。现在全部保留原样：搜索框照常显示，只是 pointer-events:none +
     tabindex=-1（muteExcept 会再加一遍），方向键永远落不进去，
     页面布局完全按网站自己的设计走，不再有「先渲染再跳」的位移。 */
  var CSS = [
    'input,textarea,select,[contenteditable] { pointer-events:none !important; }',
    '.wr_index_page_footer { display:none !important; }',
    /* ---- 首页四列：只改「列数」，不动字号和留白 ----
       页面原生把内容区锁在 max-width:1200px 居中，1440 视口下左右各留 120。
       这个宽度不改：猜你喜欢卡片本身就是 282px，4 张正好铺满 1200，
       所以它天然就是四列。只有「继续阅读」的卡片是 588px（两列），
       把它的宽度改成容器的 1/4，两块就都是四列、列宽一致、左右对齐。
       间距必须用 margin，不能用 flex gap：这台电视的 WebView 太老，
       gap 的 computed 值有、布局却不生效，卡片会贴在一起像重叠（实测踩过）。
       25% 一份 = 300px，卡片 276 + 右间距 24，四份正好 1200。 */
    '.wr_index_mini_shelf_card { width:calc(25% - 24px) !important;' +
      ' flex:0 0 calc(25% - 24px) !important; margin:0 24px 24px 0 !important;' +
      ' box-sizing:border-box !important; height:auto !important;' +
      ' min-height:112px !important; }',
    /* 每行最后一张不要右间距，否则 4×(282+24)=1224 会顶出 1200 的容器、第 4 张被挤到下一行 */
    '.wr_index_mini_shelf_card:nth-child(4n) { margin-right:0 !important; }',
    /* 卡片压窄后书名会被 nowrap 切掉，放开成两行；只此一条，字号不动 */
    '.wr_index_mini_shelf_card_content_title { white-space:normal !important;' +
      ' display:-webkit-box !important; -webkit-line-clamp:2 !important;' +
      ' -webkit-box-orient:vertical !important; }',
    '.__tv_muted { pointer-events:none !important; }',
    '.__tv_muted:focus { outline:none !important; box-shadow:none !important; }',
    'a[href],button,[tabindex],[role="button"] { outline:none !important; }',
    /* 自由光标：双层箭头（外层黑色描边 + 内层白色主体，同一 clip-path 错位嵌套），
       白底/暗底都清晰。clip-path 元素上 drop-shadow 会被裁掉，勾边必须用
       叠层实现；data-URI SVG 在 Gecko 上实测不渲染，也弃用 */
    '#__tv_cursor { position:fixed; left:0; top:0; width:36px; height:36px;' +
    '  z-index:2147483647; pointer-events:none;' +
    '  filter:drop-shadow(0 2px 4px rgba(0,0,0,.4)); }',
    '#__tv_cursor div { position:absolute; clip-path:' +
    '  polygon(0 0, 0 70%, 17% 55%, 30% 85%, 41% 80%, 29% 52%, 55% 52%); }',
    '#__tv_cursor div.__tv_cur_edge { left:0; top:0; right:0; bottom:0; background:#000; }',
    '#__tv_cursor div.__tv_cur_body { left:4px; top:4px; right:4px; bottom:4px; background:#fff; }',
    '.__tv_focus {',
    '  outline:6px solid #ff6a00 !important; outline-offset:3px !important;',
    '  box-shadow:0 0 0 10px rgba(255,106,0,.24), 0 0 30px rgba(255,106,0,.55) !important;',
    '  border-radius:14px !important;',
    '}'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;   // CSS 定义处已 join('\n') 成字符串
    (document.head || document.documentElement).appendChild(s);
  }

  /* 样式尽早落地：不等 DOMContentLoaded，避免首帧闪无样式排版 */
  (function earlyStyle() {
    if (document.head) { ensureStyle(); return; }
    var tries = 0;
    (function tick() {
      if (document.head || ++tries > 120) { if (document.head) ensureStyle(); return; }
      setTimeout(tick, 16);
    })();
  })();

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  /* 把点击点（光标位置/焦点中心）的逻辑坐标报给壳：
     所有模式的 OK 键都由壳层注入真实触摸（isTrusted=true）——既包括
     阅读页工具栏，也包括首页「换一批」这类带反自动化守卫的控件，
     页面合成事件过不了它们，所以壳必须知道往哪儿点 */
  function reportPoint(kind, x, y) {
    bridgeSend({ ev: 'point', kind: kind,
                 x: Math.round(x), y: Math.round(y), w: innerWidth });
  }

  /* 页面自带的控制按钮：已知 class + 短文本关键词兜底，排除会跳出网页的外链 */
  var CONTROL_SELECTORS = [
    '.wr_index_page_top_section_header_action_link',
    '.wr_index_page_top_section_header_title_action',
    '.navBar_link',
    '.readerControls_item',
    '.readerTopBar_link',
    '.readerTopBar_addToShelf',
    '.readerTopBar_home'
  ];
  var CONTROL_WORDS = ['书架', '书城', '首页', '登录', '刷新', '换一批', '传书到手机', '加入书架'];
  var EXCLUDE_WORDS = /墨水屏版|手机版|下载客户端|客户端下载|下载APP|下载App|APP下载/i;

  function controlTargets() {
    var out = [], i, j;
    function add(el) {
      if (!el || out.indexOf(el) >= 0) return;
      var t = (el.textContent || '').trim();
      if (EXCLUDE_WORDS.test(t)) return;
      var href = el.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href) && href.indexOf('weread.qq.com') < 0) return;
      var r = rectOf(el);
      if (r.w < 20 || r.h < 16 || r.w > 460 || r.h > 90) return;
      var c = getComputedStyle(el);
      if (c.display === 'none' || c.visibility === 'hidden' || parseFloat(c.opacity) < 0.2) return;
      for (j = 0; j < out.length; j++) {
        var q = rectOf(out[j]);
        if (Math.abs(q.x - r.x) < 30 && Math.abs(q.y - r.y) < 20 &&
            (out[j].textContent || '').trim() === t) return;
      }
      out.push(el);
    }
    for (i = 0; i < CONTROL_SELECTORS.length; i++) {
      var list = document.querySelectorAll(CONTROL_SELECTORS[i]);
      for (j = 0; j < list.length; j++) add(list[j]);
    }
    var all = document.querySelectorAll('a,button');
    for (i = 0; i < all.length; i++) {
      var e = all[i], txt = (e.textContent || '').trim();
      if (txt.length < 2 || txt.length > 8) continue;
      var hit = false;
      for (j = 0; j < CONTROL_WORDS.length; j++) {
        if (txt.indexOf(CONTROL_WORDS[j]) >= 0) { hit = true; break; }
      }
      if (hit) add(e);
    }
    return out;
  }

  /* 整块书卡：登录后首页「继续阅读」是 .wr_index_mini_shelf_card（588×109），
     内部包着一个 548×69 的 <a>。以前只框 <a>，看起来像没聚焦；现在优先整块，
     并过滤掉「祖先已经在候选里」的内部链接，避免同一张卡被导航两次。 */
  var BOOK_SELECTORS = 'a[href*="/web/reader/"], a[href*="/web/bookDetail/"], ' +
    'a.shelfBook:not(.shelfBook_add), .wr_bookList_item_link, ' +
    '.wr_index_mini_shelf_card';
  function bookTargets() {
    var arr = [], cand = document.querySelectorAll(BOOK_SELECTORS), i, j;
    for (i = 0; i < cand.length; i++) {
      var el = cand[i];
      if (el.classList && el.classList.contains('shelfBook_add')) continue;
      var r = rectOf(el);
      if (r.w >= BOOK_MIN_W && r.h >= BOOK_MIN_H) arr.push(el);
    }
    var out = [];
    for (i = 0; i < arr.length; i++) {
      var nested = false;
      for (j = 0; j < arr.length; j++) {
        if (i !== j && arr[j].contains(arr[i])) { nested = true; break; }
      }
      if (!nested) out.push(arr[i]);
    }
    return out;
  }

  function targets() {
    /* books：浏览页全部候选；focus：阅读页只有右侧工具栏 + 顶栏；
       read（纯翻页）与 cursor（自由光标）不参与焦点导航 */
    if (state.mode === 'books') return controlTargets().concat(bookTargets());
    if (state.mode === 'focus') return controlTargets();
    return [];
  }

  /* 第一次点亮焦点时的落点：
     focus 模式 → 右侧工具栏第一项（阅读页没有书卡，书卡优先逻辑会落空）；
     浏览页 → 有书卡给第一本，没有（未登录书架）给「登录」 */
  function initialTarget(list) {
    if (state.mode === 'focus') return list[0];
    var books = bookTargets();
    if (books.length) return books[0];
    for (var i = 0; i < list.length; i++) {
      if ((list[i].textContent || '').trim() === '登录') return list[i];
    }
    return list[0];
  }

  function muteExcept(list, modal) {
    var els = document.querySelectorAll('a[href],button,input,textarea,select,[tabindex],[role="button"]');
    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      if (modal && (modal === el || modal.contains(el))) continue;
      el.setAttribute('tabindex', '-1');
      if (list.indexOf(el) < 0) el.classList.add('__tv_muted');
      else el.classList.remove('__tv_muted');
    }
  }

  function clearMuted() {
    var els = document.querySelectorAll('.__tv_muted');
    for (var j = 0; j < els.length; j++) els[j].classList.remove('__tv_muted');
  }

  /* 只在目标不完整可见时才滚，且滚到最近位置，不再每次都 center 把页面拽动 */
  function reveal(el) {
    var r = el.getBoundingClientRect();
    if (r.top >= 8 && r.bottom <= innerHeight - 8 &&
        r.left >= 8 && r.right <= innerWidth - 8) return;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    catch (e) { el.scrollIntoView(); }
  }

  function setFocus(el, scroll) {
    if (state.focusEl && state.focusEl.classList) state.focusEl.classList.remove('__tv_focus');
    state.focusEl = el || null;
    if (!el) return;
    el.classList.add('__tv_focus');
    if (scroll) reveal(el);
    try {
      var r = rectOf(el);
      reportPoint('focus', r.cx, r.cy);
    } catch (e) {}
  }

  /* 页面水合会重写 className 把橙框抹掉，焦点没变也要补回 class */
  function keepFocus(el, scroll) {
    if (state.focusEl !== el) setFocus(el, scroll);
    else if (el && el.classList) el.classList.add('__tv_focus');
  }

  function apply() {
    if (state.applying || !document.body) return;
    state.applying = true;
    try {
      ensureStyle();
      if (!isReader() && state.mode === 'read') state.mode = 'books';

      if (state.mode === 'cursor') {
        /* 自由光标依赖 elementFromPoint 命中检测：__tv_muted 的 pointer-events:none
           会让命中结果跳到父级，所以光标模式下必须先清掉 mute，退出时再补回 */
        clearMuted();
        setFocus(null);
        return;
      }
      var modal = visibleModal();
      syncModal(!!modal);
      var list = targets();
      muteExcept(list, modal);
      if (modal || !list.length) { setFocus(null); return; }

      /* 首启：没有橙框、也没有任何滚动，等用户自己按第一下 */
      if (state.virgin) { setFocus(null); return; }

      if (!state.userMoved && state.mode === 'books') {
        var t = initialTarget(list);
        if (t) { keepFocus(t, false); return; }
      }
      if (!state.focusEl || !document.contains(state.focusEl) || list.indexOf(state.focusEl) < 0) {
        setFocus(list[0], false);
      } else {
        state.focusEl.classList.add('__tv_focus');
      }
    } finally { state.applying = false; }
  }

  function inView(el) {
    /* 与视口相交即可（部分可见算在）：要求「完全可见」会让底边被截断的
       卡片永远进不了焦点，方向键就在它和上方卡片之间来回弹（真机踩过） */
    var r = rectOf(el);
    return r.y < innerHeight && r.y + r.h > 0 && r.x < innerWidth && r.x + r.w > 0;
  }

  /* 焦点元素已被滚出视口（上一步「到头继续滚」所致）：
     把焦点重新落到视口内离它最近的候选上，本次按键只做这件事。 */
  function refocusVisible() {
    var list = targets(), cur = rectOf(state.focusEl);
    var best = null, bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      if (!inView(list[i])) continue;
      var r = rectOf(list[i]);
      var d = Math.abs(r.cx - cur.cx) + Math.abs(r.cy - cur.cy);
      if (d < bestScore) { bestScore = d; best = list[i]; }
    }
    if (best) setFocus(best, false);
  }

  /* 焦点已是最底/最顶候选、页面还没滚到头：继续按键改为整页滚动。
     这样遥控器按住 DOWN 能一路看到页面真正的底部（书架页的滚动
     懒加载也靠它触发），按住 UP 能回到页面顶部。 */
  function pageScroll(dir) {
    var max = document.documentElement.scrollHeight - innerHeight;
    var y = window.pageYOffset;
    if (dir === 'down' ? y >= max - 4 : y <= 4) return;   // 已到底/顶
    var step = Math.round(innerHeight * 0.8);
    try { window.scrollBy({ top: dir === 'down' ? step : -step, behavior: 'smooth' }); }
    catch (e) { window.scrollBy(0, dir === 'down' ? step : -step); }
  }

  function move(dir) {
    var _m = modalOpen();
    var list = targets();
    if (_m) return;
    if (!list.length) return;
    /* 第一下：只点亮、不移动、不滚动 */
    if (state.virgin || !state.focusEl || list.indexOf(state.focusEl) < 0) {
      state.virgin = false; state.userMoved = true;
      setFocus(initialTarget(list), false);
      return;
    }
    /* 上一步纯滚动把焦点带出了视口：先回位，不导航 */
    if (!inView(state.focusEl)) { refocusVisible(); return; }
    var cur = rectOf(state.focusEl), best = null, bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var el = list[i]; if (el === state.focusEl) continue;
      var r = rectOf(el), dx = r.cx - cur.cx, dy = r.cy - cur.cy;
      var primary = 0, secondary = 0, overlap = false;
      if (dir === 'right') {
        if (dx <= 8) continue;
        primary = dx; secondary = Math.abs(dy);
        overlap = !(r.y > cur.y + cur.h || r.y + r.h < cur.y);
      } else if (dir === 'left') {
        if (dx >= -8) continue;
        primary = -dx; secondary = Math.abs(dy);
        overlap = !(r.y > cur.y + cur.h || r.y + r.h < cur.y);
      } else if (dir === 'down') {
        if (dy <= 8) continue;
        primary = dy; secondary = Math.abs(dx);
        overlap = !(r.x > cur.x + cur.w || r.x + r.w < cur.x);
      } else {
        if (dy >= -8) continue;
        primary = -dy; secondary = Math.abs(dx);
        overlap = !(r.x > cur.x + cur.w || r.x + r.w < cur.x);
      }
      var score = primary + secondary * 2 + (overlap ? 0 : 600);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { state.userMoved = true; setFocus(best, true); }
    else if (dir === 'down' || dir === 'up') pageScroll(dir);
  }

  function activate() {
    if (modalOpen()) return;
    var el = state.focusEl;
    if (state.virgin || !el || !document.contains(el)) {
      var list = targets();
      if (!list.length) return;
      state.virgin = false; state.userMoved = true;
      setFocus(initialTarget(list), false);   // 无焦点时 OK 只点亮，不误触
      return;
    }
    try {
      if (el.tagName !== 'A') {
        var a = el.querySelector('a[href]');
        if (a) { a.click(); return; }
      }
      el.click();
    } catch (e) {
      var h = el.getAttribute('href');
      if (h && h.indexOf('javascript') !== 0) location.href = h;
    }
  }

  /* ===================== 自由光标模式（全页面） =====================
     方向键像素级移动一个模拟鼠标指针，OK 在指针位置派发完整点击事件序列。
     评论面板、划线菜单这类「焦点框搞不定」的复杂交互都靠它。
     壳侧的滚动模式复用同一个 'cursor' 模式，只是把方向键改发 op:'scroll'。 */
  var cursorEl = null, cursorX = 0, cursorY = 0;

  function cursorInit() {
    if (cursorEl) return;
    cursorEl = document.createElement('div');
    cursorEl.id = '__tv_cursor';
    var edge = document.createElement('div');
    edge.className = '__tv_cur_edge';
    var body = document.createElement('div');
    body.className = '__tv_cur_body';
    cursorEl.appendChild(edge);
    cursorEl.appendChild(body);
    (document.body || document.documentElement).appendChild(cursorEl);
    cursorX = Math.round(innerWidth / 2);
    cursorY = Math.round(innerHeight / 2);
    placeCursor();
    reportPoint('cursor', cursorX, cursorY);
  }

  function cursorDestroy() {
    if (cursorEl) { try { cursorEl.remove(); } catch (e) {} cursorEl = null; }
  }

  function placeCursor() {
    if (!cursorEl) return;
    cursorEl.style.left = cursorX + 'px';
    cursorEl.style.top = cursorY + 'px';
  }

  function cursorMove(dx, dy) {
    if (!cursorEl || !document.contains(cursorEl)) cursorInit();
    cursorX = Math.max(0, Math.min(innerWidth - 2, cursorX + dx));
    cursorY = Math.max(0, Math.min(innerHeight - 2, cursorY + dy));
    placeCursor();
    reportPoint('cursor', cursorX, cursorY);
    /* 移动途中派发 mousemove：React 组件监听 onMouseEnter/Move 驱动的
       hover 高亮能跟着光标走，用户能看到「悬停在哪个按钮上」 */
    try {
      var over = pointTarget(cursorX, cursorY);
      if (over && over !== cursorEl) {
        over.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, view: window,
          clientX: cursorX, clientY: cursorY
        }));
      }
    } catch (e) {}
  }

  /* 光标命中定位（两段式）：
     ① 层叠链：elementsFromPoint 自上而下找第一个可交互元素再提升到容器；
     ② 几何兜底：右侧工具栏被页面 CSS 设成 pointer-events:none 时（触屏/
        粗指针环境的降级样式，电视上 UA/指针媒体查询很可能命中），
        elementsFromPoint 整个子树都不返回它，①永远落空——上一页/下一页
        按钮没有这个样式所以能点中。直接按矩形包含关系搜全部可交互元素，
        取面积最小的命中块（最具体的目标）。 */
  function pointTarget(x, y) {
    var stack = null;
    try { stack = document.elementsFromPoint(x, y); } catch (e) {}
    if (!stack || !stack.length) {
      var one = document.elementFromPoint(x, y);
      stack = one ? [one] : [];
    }
    var hit = null, i, j;
    for (i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (!el || el === cursorEl) continue;
      var up = el.closest ?
        el.closest('a,button,[role="button"],.readerControls_item,.readerTopBar_link') : null;
      if (up) { hit = up; break; }
      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') { hit = el; break; }
    }
    var best = null, bestArea = Infinity;
    var list = document.querySelectorAll('a,button,[role="button"],.readerControls_item,.readerTopBar_link');
    for (j = 0; j < list.length; j++) {
      var r = list[j].getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      var area = r.width * r.height;
      if (area < bestArea) { bestArea = area; best = list[j]; }
    }
    /* 几何命中比层叠命中更具体（更小/是它的子节点）时优先 */
    if (best && (!hit || hit.contains(best) ||
        bestArea < hit.getBoundingClientRect().width * hit.getBoundingClientRect().height)) {
      hit = best;
    }
    return hit;
  }

  function cursorClick() {
    if (!cursorEl) cursorInit();
    var el = pointTarget(cursorX, cursorY);
    if (!el) return;
    /* 注意：这只用于壳层触摸注入失败时的兜底。阅读页的工具栏/面板交互有
       isTrusted 守卫（反自动化），合成事件一律无效（真机实测：完整事件
       序列、el.click() 都没反应，input tap 真实触摸有效），正常路径是
       壳层 PanZoomController 注入真实触摸 */
    var D = { bubbles: true, cancelable: true, view: window,
              clientX: cursorX, clientY: cursorY, button: 0, buttons: 1,
              detail: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    var U = {}, k;
    for (k in D) U[k] = D[k];
    U.buttons = 0;
    try { el.dispatchEvent(new MouseEvent('mousemove', U)); } catch (e) {}
    var seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < seq.length; i++) {
      var isP = seq[i].indexOf('pointer') === 0;
      var isUp = seq[i].indexOf('up') >= 0 || seq[i] === 'click';
      var E = isP ? (window.PointerEvent || MouseEvent) : MouseEvent;
      try { el.dispatchEvent(new E(seq[i], isUp ? U : D)); } catch (e) {}
    }
  }

  /* ===================== 滚动模式 =====================
     光标停在原地不再移动，上/下/左/右各滚对应方向。以光标屏幕坐标为锚点：
     ① 优先滚「光标命中的最近可滚动内部容器」（评论面板、目录这类）；
     ② 没有内部容器就滚文档；③ 文档也不可滚才派发 wheel 给页面自己的
        滚动逻辑（阅读器 canvas / 虚拟列表常监听 wheel）。三条互斥，一次
        按键只产生一段位移。光标有 pointer-events:none，不会挡住元素命中。
     步长 step（CSS 像素）由壳侧下发：单按小步，连按/长按逐级加速，横纵共用。 */
  function scrollAtCursor(dir, step) {
    step = parseInt(step, 10) || 72;
    var dx = dir === 'left' ? -step : dir === 'right' ? step : 0;
    var dy = dir === 'up' ? -step : dir === 'down' ? step : 0;
    if (!dx && !dy) return;
    /* 内部容器才用 Element.scrollBy；body / documentElement 在标准模式下
       不接管视口滚动，交给 window.scrollBy（scrollingElement）才可靠 */
    var el = document.elementFromPoint(cursorX, cursorY);
    while (el && el !== document.body && el !== document.documentElement) {
      if ((dy && el.scrollHeight > el.clientHeight + 1) ||
          (dx && el.scrollWidth > el.clientWidth + 1)) {
        el.scrollBy(dx, dy);
        return;
      }
      el = el.parentElement;
    }
    var doc = document.scrollingElement || document.documentElement;
    if ((dy && doc.scrollHeight > doc.clientHeight + 1) ||
        (dx && doc.scrollWidth > doc.clientWidth + 1)) {
      window.scrollBy(dx, dy);
      return;
    }
    /* 合成 wheel 的 isTrusted=false，不会触发浏览器默认滚动，所以不会和
       上面的 scrollBy 叠加；这里只用于把方向交给页面自己的 wheel 处理器 */
    try {
      (document.elementFromPoint(cursorX, cursorY) || document.body).dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true, cancelable: true, view: window,
          clientX: cursorX, clientY: cursorY,
          deltaX: dx, deltaY: dy, deltaMode: 0
        }));
    } catch (e) {}
  }

  function refresh() {
    clearTimeout(state.timer);
    state.timer = setTimeout(apply, 120);
  }

  var api = {
    v: V,
    move: move, activate: activate, refresh: apply,
    setMode: function (m) {
      if (m !== state.mode) { state.mode = m; state.userMoved = false; }
      /* 进焦点模式不自动亮框：第一下方向键才点亮（与浏览页首启一致） */
      if (m === 'focus') { state.virgin = true; state.focusEl = null; }
      if (m === 'cursor') { cursorInit(); }
      else { cursorDestroy(); }
      apply();
    },
    /* 返回键先关弹窗；返回 '1' 表示已消费，Activity 就不再后退 */
    closeModal: function () {
      var m = visibleModal();
      if (!m) return '0';
      var btn = m.querySelector('.wr_login_modal_close, .wr_dialog_closeButton') ||
                m.querySelector('button') ||
                m.querySelector('[class*="close"]') ||
                document.querySelector('.wr_login_modal_close, .wr_dialog_closeButton');
      if (btn) btn.click(); else m.style.display = 'none';
      if (location.hash === '#login') {
        try { history.replaceState(null, '', location.pathname + location.search); }
        catch (e) { location.hash = ''; }
      }
      state.userMoved = false;
      apply();
      return '1';
    },
    state: function () {
      return { mode: state.mode, reader: isReader(),
               count: targets().length, modal: modalOpen(), virgin: state.virgin,
               cursor: cursorEl ? { x: cursorX, y: cursorY } : null,
               focus: state.focusEl ? ((state.focusEl.textContent || '').trim().slice(0, 24)) : null,
               url: location.href };
    }
  };
  window.__tv = api;

  function boot() {
    apply();
    var mo = new MutationObserver(function () { refresh(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // 页面变化检测收敛为「无轮询」三件套（替换原先 600ms setInterval 轮询）：
    //  1) 壳侧 navigationDelegate 捕获跨文档导航（进/出阅读页等整页加载）；
    //  2) MutationObserver 捕获同文档 DOM 变化（水合、SPA 路由导致的重排）；
    //  3) hashchange / popstate 兜底纯 hash 与历史栈变化。
    window.addEventListener('hashchange', refresh);
    window.addEventListener('popstate', refresh);
    window.addEventListener('resize', refresh);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else boot();

  /* ===================== 与壳的 native messaging 端口 ===================== */
  var port = null;
  var sendQueue = [];
  function bridgeSend(obj) {
    if (port) { try { port.postMessage(obj); return; } catch (e) {} }
    sendQueue.push(obj);
    if (sendQueue.length > 64) sendQueue.shift();
  }
  function handleNative(m) {
    switch (m && m.op) {
      case 'move':        move(m.dir); break;
      /* 壳侧 jsCommand 参数是字符串，必须 parseInt，否则 number+string=NaN */
      case 'cursorMove':  cursorMove(parseInt(m.dx, 10) || 0, parseInt(m.dy, 10) || 0); break;
      case 'cursorClick': cursorClick(); break;
      case 'scroll':      scrollAtCursor(m.dir, m.step); break;
      case 'ok':         activate(); break;
      case 'key':        webKey(m.key, m.code); break;   // 阅读页翻页：合成键盘事件
      /* 注意：setMode/closeModal/focusSelector 是 api 的属性不是独立函数，
         裸调用 ReferenceError 会被端口监听的 try/catch 吞掉（曾导致
         mode 命令静默失败，阅读页一直停在 books 模式） */
      case 'mode':       api.setMode(m.mode); break;
      case 'closeModal': api.closeModal(); break;
    }
  }
  function webKey(key, code) {
    var t = document.querySelector('#app, #root, #__next') || document.body || document;
    var o = { key: key, code: key, keyCode: code, which: code,
              bubbles: true, cancelable: true };
    t.dispatchEvent(new KeyboardEvent('keydown', o));
    t.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  function connectPort() {
    try {
      port = browser.runtime.connectNative('weread_tv');
      port.onMessage.addListener(function (m) { try { handleNative(m); } catch (e) {} });
      while (sendQueue.length) { try { port.postMessage(sendQueue.shift()); } catch (e) { break; } }
    } catch (e) {
      port = null;
      setTimeout(connectPort, 300);
    }
  }
  if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.connectNative) {
    connectPort();
  } else {
    setTimeout(connectPort, 80);
  }
})();
