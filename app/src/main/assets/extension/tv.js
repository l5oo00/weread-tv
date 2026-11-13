/* WeRead 电视壳 · 页面适配层（零依赖，零新增 UI 组件）
 *
 * 运行形态：本脚本由 GeckoView 以 WebExtension content script
 * （document_start）官方机制加载，不再 evaluateJavascript 注入。
 * 与壳的通信走 native messaging 端口：
 *   JS → 壳：{ev:'modal',open}
 *   壳 → JS：{op:'move',dir} {op:'ok'} {op:'key',key,code} {op:'mode',mode}
 *            {op:'cursorMove',dx,dy} {op:'cursorClick'} {op:'scroll',dir,step}
 *            {op:'pageV',dir} {op:'closeModal'}
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
  var V = 15;

  /* ==== 阅读页首屏：两个同步第三方脚本推迟到正文首帧后补加载 ====
   * 阅读页 SSR HTML 里 midas cashier.js（支付）和 wpa-1.0.5.js（风控/设备指纹）
   * 都是无 defer/async 的同步 <script>，会阻塞 HTML 解析；wpa 还会拉 WASM 占主线程。
   * 用 Gecko 的 beforescriptexecute 挡住它们的首次执行，正文首帧后再动态补 <script>
   * 让它们完整跑一遍 —— 风控/账号校验相关请求不能丢，只是挪出首屏关键路径。
   * 实测（固定书 d0b32ed0813abc2b3g0147b9、正式包 1440 双页）：
   *   正文首现 39.2s → 37.3s / 36.9s，与「永久拦掉」的 37.5s 持平；
   *   补加载后 chaos VM = function、WASM 资源 = 1、两个脚本均触发 load。
   * 只在阅读页生效，首页与其它页面完全不受影响。
   * 等 canvas 首现是必要的：load 后就补会慢 1.2s；60s 兜底保证异常页面也能补上。
   */
  (function () {
    if (location.pathname.indexOf('/web/reader/') !== 0) return;
    var s = document.createElement('script');
    s.textContent = '(' + function () {
      var pending = [];
      document.addEventListener('beforescriptexecute', function (e) {
        var t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-tv-reload')) return;
        var u = (t && t.src) || '';
        if (/midas.*cashier\.js|wpa-1\.0\.5\.js/.test(u)) {
          e.preventDefault();
          pending.push(u);
        }
      }, true);
      function flush() {
        pending.forEach(function (u) {
          var n = document.createElement('script');
          n.src = u;
          n.async = true;
          n.setAttribute('data-tv-reload', '1');
          (document.head || document.documentElement).appendChild(n);
        });
        pending.length = 0;
      }
      var done = 0;
      function go() { if (done) return; done = 1; flush(); }
      var iv = setInterval(function () {
        if (document.getElementsByTagName('canvas').length) {
          clearInterval(iv);
          setTimeout(go, 900);
        }
      }, 300);
      setTimeout(function () { clearInterval(iv); go(); }, 60000);
    }.toString() + ')();';
    (document.documentElement || document.head).appendChild(s);
    s.remove();
  })();

  /* ==== 字体：熔断自愈 + 排版后补排 ====
   *
   * 站点阅读页 mounted 里 Promise.race([warmUp(), 10 秒定时]) 决定 ignoreFont：
   * warmUp 没在 10 秒内跑完就置 true（「字体系统坏了」），之后 changeFontFamily /
   * handleChangeFont / drawPage 开头全是 if (ignoreFont) return，点字体连请求都不发。
   * 这台电视 warmUp 要 33 秒，实测 5 次加载 4 次误判。
   *
   * 1) 熔断自愈：读 ignoreFont 时若 fontProvider.localFonts 已有内容就改回 false。
   *    warmUp 真挂了 localFonts 永远是空数组，站点降级照旧 —— 不写死 false。
   * 2) 排版补排：正文是 canvas 画的，字体串来自排版产物；canvas 不等解码就同步
   *    回退系统字体并画死，而站点只在换字体时 layout、不会补。所以包住 layout：
   *    照常排版（看到的是回退字体），等这次要用的 face decoded 了再补排一次。
   *    不阻塞排版，代价是字体晚到时会先显示系统字体、再跳成目标字体。
   */
  try {
    if (!window.__tvFontShim) {
      window.__tvFontShim = 1;
      var __tvFont = function () {
        var dp = Object.defineProperty;
        window.__tvFontOn = { at: Math.round(performance.now()), rs: document.readyState };   // 注入标记，调试用

        /* 用户选的字体；'wr_default_font' 表示没设 */
        function savedFont() {
          try {
            var o = JSON.parse(localStorage.getItem('wrLocalSetting') || '{}');
            var f = (o && o.fontFamily) || '';
            return f === 'wr_default_font' ? '' : f;
          } catch (e) { return ''; }
        }

        /* 站点注入的 @font-face 就用字体 id 当 family。同一 family 可能有多条
           （按 unicode-range 分片），要全部 decoded 才不会中途回退 */
        function faceSt(fam) {
          var set = document.fonts, n = 0, pend = 0;
          if (!set || !set.forEach) return 'noface';
          set.forEach(function (f) {
            if (f.family.replace(/^["']|["']$/g, '') !== fam) return;
            n++;
            if (f.status !== 'loaded' && f.status !== 'error') pend++;
          });
          return n ? (pend ? 'loading' : 'loaded') : 'noface';
        }

        /* face 停在 unloaded 不会自己加载，主动踢一脚（实测踢完 1.2 秒 loaded） */
        function kick(fam) {
          try { document.fonts.load('16px "' + fam + '"'); } catch (e) {}
        }

        /* 常态催解码：选中的字体没 decoded 就每秒踢一次（没注册时是空操作） */
        setInterval(function () {
          var fam = savedFont();
          if (fam && faceSt(fam) !== 'loaded') kick(fam);
        }, 1000);

        /* 包住每个 reader 实例的 layout，不等待：照常排版（字体没就绪时 canvas 会
           回退系统字体），等 face decoded 了再补排一次换成正确的 */
        function gate(vm) {
          if (vm.__tvFontGate || typeof vm.layout !== 'function') return;
          vm.__tvFontGate = 1;
          var orig = vm.layout, fixed = '';

          /* 补排：站点那次 layout 可能被它的 chapterContentState 门挡掉，所以
             1.5 秒后再确认一次，最多两次。一律用闭包 vm，站点给的 this 不可信 */
          function mend(fam) {
            if (vm.__tvMend === fam) return;
            vm.__tvMend = fam;
            var t0 = Date.now(), tries = 0;
            (function tick() {
              if (savedFont() !== fam) { vm.__tvMend = ''; return; }   // 期间又换了字体
              if (faceSt(fam) === 'loaded') {
                if (++tries > 2) { vm.__tvMend = ''; return; }
                fixed = fam;
                try { vm.layout(); } catch (e) {}
                setTimeout(tick, 1500);
                return;
              }
              if (Date.now() - t0 > 60000) { vm.__tvMend = ''; return; }
              setTimeout(tick, 250);
            })();
          }

          vm.layout = function () {
            var r = orig.apply(vm, arguments), fam = savedFont();
            if (fam && fam !== fixed && faceSt(fam) !== 'loaded') mend(fam);
            return r;
          };
        }

        Object.defineProperty = function (o, k, d) {
          if (k === 'ignoreFont' && d && typeof d.get === 'function' &&
              typeof d.set === 'function') {
            var raw = d;
            gate(o);   // data 初始化时 methods 已就位，vm.layout 已经存在
            d = {
              configurable: true, enumerable: true,
              /* 读的时候顺手自愈：字体库真有内容了就改回 false。写回走 raw.set，
                 保留 Vue 的响应式；localFonts 还是空数组就一动不动 */
              get: function () {
                var v = raw.get.call(this);
                if (v === true) {
                  var p = this.$refs && this.$refs.fontProvider;
                  if (p && p.localFonts && p.localFonts.length) {
                    raw.set.call(this, false);
                    return false;
                  }
                }
                return v;
              },
              set: function (v) { raw.set.call(this, v); }
            };
          }
          return dp.call(Object, o, k, d);
        };
      };
      var __tvFontS = document.createElement('script');
      __tvFontS.textContent = '(' + __tvFont.toString() + ')();';
      (document.documentElement || document.head).appendChild(__tvFontS);
      __tvFontS.remove();
    }
  } catch (e) {}
  /* ==== 字体补丁结束 ==== */

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

  /* ==== 阅读页弹层：站点自己的面板 / 对话框 ====
   * 目录、书评（列表 / 详情）、字体排版、AI 问书、笔记、搜索、各类 dialog 都是
   * 站点自己的浮层，打开时统一铺一层 .wr_mask 遮罩。返回键要能关掉它们，
   * 壳层必须先知道两件事：现在有没有弹层、该点哪儿。
   *   ① 面板左上角有返回箭头的（书评详情这类子页）→ 点返回（回列表，不是关闭）；
   *   ② 没有返回但有关闭按钮的 → 点关闭；
   *   ③ 都没有的（目录、字体这类）→ 点遮罩空白处，也就是站点自己的「点外面关掉」。
   * 面板里的按钮带 isTrusted 守卫，合成点击一律无效 —— 所以只回报坐标，
   * 由壳层注入真实触摸，和右侧工具栏同一套办法。
   * 图片放大层（点正文插图弹出，Viewer.js）不是 wr_mask 家族：全屏
   * .viewer-container，点空白关闭、点图上缩放，落点单独算（见 panelClosePoint）。 */
  var PANEL_ROOTS = '.reader_float_panel_container, .readerCatalog, .readerNotePanel, ' +
    '.readerAIChatPanel, .font-panel-content, .search_panel, .top_reviews_panel, ' +
    '.reviews_panel, .reader_common_dialog_wrapper, .wr_dialog, ' +
    '.viewer-container.viewer-backdrop';
  var PANEL_CLOSE = '.reader_float_panel_header_closeBtn, ' +
    '.search_panel_header_close_wrapper, .wr_dialog_closeButton';
  var PANEL_BACK = '.reader_float_panel_header_backBtn';

  /* 「开着」只能用「真的画出来了」判断：关掉的面板 DOM 常驻（容器 display:none），
     遮罩则在 opacity 0/1 之间切，所以尺寸 + display + visibility + opacity 一起看。
     遮罩单独也算——有些弹层（会员/支付类 dialog）只有遮罩没有上面这些容器。 */
  function shown(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect(), c = getComputedStyle(el);
    return r.width > 20 && r.height > 20 && c.display !== 'none' &&
      c.visibility !== 'hidden' && parseFloat(c.opacity) > 0.1;
  }

  function shownIn(sel, root) {
    var list = (root || document).querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) if (shown(list[i])) return list[i];
    return null;
  }

  /* 同一时刻只开一个弹层，返回 / 关闭按钮全局找「画出来的那个」就够 */
  function readerPanel() {
    var root = shownIn(PANEL_ROOTS), mask = shownIn('.wr_mask');
    if (!root && !mask) return null;
    return { root: root, mask: mask,
             back: shownIn(PANEL_BACK), close: shownIn(PANEL_CLOSE) };
  }

  /* 关这一层要点的坐标；null = 没有弹层，或者找不到安全落点（居中铺满的弹窗） */
  function panelClosePoint(p) {
    if (!p) return null;
    var el = p.back || p.close;
    if (el) { var b = rectOf(el); return { x: b.cx, y: b.cy }; }
    /* 图片放大层（Viewer.js）：全屏 container，点空白（canvas 露出的地方）关闭、
       点图上是缩放。放大图居中显示，屏幕四角（内缩 10px）几乎总有空白 ——
       角落要落在图上，必须左右、上下两个方向都贴死屏幕边（基本只有 1:1
       拉满才这样），比左右/上下边中点鲁棒。图可拖动，四角逐个检查挑一个
       不在图上的（先上角后下角：底边偶有 viewer-footer 标题条）；
       全被盖住就放弃，返回键走 closeModal 兜底。 */
    if (p.root && p.root.className.indexOf('viewer-container') >= 0) {
      var img = shownIn('.viewer-move', p.root);
      if (!img) return null;
      var r = rectOf(img), corners = [
        { x: 10, y: 10 }, { x: innerWidth - 10, y: 10 },
        { x: 10, y: innerHeight - 10 }, { x: innerWidth - 10, y: innerHeight - 10 }
      ], ci;
      for (ci = 0; ci < 4; ci++) {
        var c = corners[ci];
        if (c.x < r.x - 8 || c.x > r.x + r.w + 8 ||
            c.y < r.y - 8 || c.y > r.y + r.h + 8) return { x: c.x, y: c.y };
      }
      return null;
    }
    if (!p.mask) return null;
    var m = rectOf(p.mask), r = p.root ? rectOf(p.root) : null, x;
    /* 落点要在遮罩上、且不被面板盖住：面板靠右就点左侧，靠左就点右侧。
       居中或铺满时遮罩会被面板整块压住，没有安全点，交给关闭按钮 */
    if (r && r.x > 120) x = r.x / 2;
    else if (r && r.x + r.w < innerWidth - 120) x = (r.x + r.w + innerWidth) / 2;
    else return null;
    return { x: x, y: Math.max(m.y + 20, Math.min(m.y + m.h - 20, m.cy)) };
  }

  /* 把「有没有弹层」+「关它点哪儿」同步给壳层。返回键要在按键当下就决定怎么走，
     不能等异步回调（SPA 导航期间会延迟数秒）。
     每次都重发，不做去重：壳层那边一旦漏掉一次坐标，返回键就会退化成合成的
     .click()（面板按钮有 isTrusted 守卫，点不动），面板就关不掉了 —— 真机踩过。
     p 允许由调用方先算好传进来（apply 里要用同一个结果做 mute 例外） */
  var lastClosePt = null, panelTimer = 0;
  function syncPanel(p) {
    if (p === undefined) p = readerPanel();
    syncModal(!!visibleModal() || !!p);
    var pt = panelClosePoint(p);
    if (pt) {
      lastClosePt = pt;
      reportPoint('close', pt.x, pt.y);
    } else if (lastClosePt) {
      lastClosePt = null;
      bridgeSend({ ev: 'point', kind: 'close', x: -1, y: -1, w: innerWidth });
    }
    /* 面板开着就自己续一次：关合是动画（改 opacity / class），DOM 不会有
       childList 变化，不续查的话「刚关掉」这个状态传不出去，下一次返回键会
       被当成「还有弹层」白吞一下。关了就不再排，不常驻轮询 */
    clearTimeout(panelTimer);
    if (p) panelTimer = setTimeout(function () { syncPanel(); }, 400);
  }

  /* 把「有没有弹窗」同步告诉 Activity。返回键要在按键当下就决定是关弹窗还是退出，
     不能等 evaluateJavascript 的异步回调（SPA 导航期间回调会延迟数秒）。
     每次 DOM 变化都重发：这个状态漏一次，返回键就走错分支（先按模式栈退出、
     面板留在屏幕上），而一条几十字节的消息便宜到不值得去重。 */
  function syncModal(open) {
    bridgeSend({ ev: 'modal', open: open });
  }

  /* 弹层的开合靠 class / 内联样式切显隐，DOM 结构根本不动 —— MutationObserver
     只盯 childList，收不到这种变化，所以「点开目录」不会触发 apply()。
     电视上的交互全部来自点击（含壳层注入的真实触摸），就在点击后补两次：
     立即一次，350ms 一次（等开合动画把 opacity 走完）。不用轮询。 */
  document.addEventListener('pointerup', function () {
    setTimeout(function () { syncPanel(); }, 30);
    setTimeout(function () { syncPanel(); }, 350);
  }, true);

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

  /* 整块书卡（.wr_index_mini_shelf_card 这类非 <a> 元素）当焦点时，卡片内部的
     <a href="/web/reader/..."> 不在候选列表里：bookTargets 特意排除嵌套链接，
     避免同一张卡被导航两次。若照样给它加 __tv_muted(pointer-events:none)，
     壳层按卡片中心注入的真实触摸会穿透链接落到外层 div，页面收不到点击 ——
     首页「继续阅读」在焦点模式下按 OK 没反应，切自由光标（clearMuted）才行。
     这类内部链接不 mute，tabindex=-1 仍保留，方向键不会误入。 */
  function insideCardLink(el, list) {
    if ((el.tagName || '').toLowerCase() !== 'a' || !el.getAttribute('href')) return false;
    for (var k = 0; k < list.length; k++) {
      var card = list[k];
      if (card !== el && (card.tagName || '').toLowerCase() !== 'a' &&
          card.contains && card.contains(el)) return true;
    }
    return false;
  }

  function muteExcept(list, modal) {
    var els = document.querySelectorAll('a[href],button,input,textarea,select,[tabindex],[role="button"]');
    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      if (modal && (modal === el || modal.contains(el))) continue;
      /* 图片放大层（Viewer.js）容器自带 tabindex，会被选择器捞进来；它关闭后
         节点不删（viewer-hide 常驻 DOM），下次 apply 时它不 shown、不算弹层，
         就被 mute 上 —— 重开就是 pointer-events:none，点空白/返回键注入的点击
         全部穿透到下层阅读页，放大层永远关不掉（自由光标没事：clearMuted
         全清了）。放大层整棵子树永不 mute，顺手清掉残留的 class。 */
      if (el.closest && el.closest('.viewer-container')) {
        el.classList.remove('__tv_muted');
        continue;
      }
      el.setAttribute('tabindex', '-1');
      if (list.indexOf(el) < 0 && !insideCardLink(el, list)) el.classList.add('__tv_muted');
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

      var panel = readerPanel();
      if (state.mode === 'cursor') {
        /* 自由光标依赖 elementFromPoint 命中检测：__tv_muted 的 pointer-events:none
           会让命中结果跳到父级，所以光标模式下必须先清掉 mute，退出时再补回 */
        clearMuted();
        setFocus(null);
        /* 弹层恰好都是在光标模式下开的，同步不能因为这里提前 return 而停掉 */
        syncPanel(panel);
        return;
      }
      var modal = visibleModal();
      syncPanel(panel);
      var list = targets();
      /* 弹层里的按钮不能 mute：__tv_muted 是 pointer-events:none，壳层注入的真实
         触摸会直接穿过它落到父节点，返回/关闭就点不动了。只把弹层本身当例外 */
      muteExcept(list, modal || (panel && (panel.root || panel.mask)));
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
  /* 元素自己能不能真的滚：光看 scrollHeight > clientHeight 不够 ——
     overflow:visible 的容器内容溢出时高度关系照样成立，但 scrollBy 对它
     完全无效（scrollTop 恒为 0）。之前这里少了 overflow 判断，滚动命令一路
     命中阅读页某个 overflow:visible 的包裹层，scrollBy 无效后直接 return，
     永远走不到 window.scrollBy —— 竖屏长页「滚不动」的根因。 */
  function scrollable(node, dx, dy) {
    var cs = getComputedStyle(node);
    var oy = cs.overflowY, ox = cs.overflowX;
    var vy = oy === 'auto' || oy === 'scroll';
    var vx = ox === 'auto' || ox === 'scroll';
    if (dy && vy && node.scrollHeight > node.clientHeight + 1) return true;
    if (dx && vx && node.scrollWidth > node.clientWidth + 1) return true;
    return false;
  }

  function scrollAtCursor(dir, step) {
    step = parseInt(step, 10) || 72;
    var dx = dir === 'left' ? -step : dir === 'right' ? step : 0;
    var dy = dir === 'up' ? -step : dir === 'down' ? step : 0;
    if (!dx && !dy) return;
    /* 内部容器才用 Element.scrollBy；body / documentElement 在标准模式下
       不接管视口滚动，交给 window.scrollBy（scrollingElement）才可靠 */
    var el = document.elementFromPoint(cursorX, cursorY);
    while (el && el !== document.body && el !== document.documentElement) {
      if (scrollable(el, dx, dy)) {
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

  /* ===================== 阅读模式：上下键 =====================
     站点有两种排版：分页（横屏双栏，底下有「上一页/下一页」）和竖屏长页
     （整章画在一张 canvas 上，文档可滚）。这里不去猜是哪一种 —— 直接试：
     滚一屏，读回 scrollTop。
       变了   → 确实是长页，滚动即成功；
       没变   → 页面不可滚（分页排版）或者已到章末，转成翻页。
     判据只依赖「引擎认不认这次滚动」，跟站点类名、DOM 结构、阅读设置项
     都无关，改版也打不中；而且就算哪天 scrollTo 被站点拦掉，读回同样是
     没动，照样落到翻页分支 —— 不会出现「按了没反应」的死角。
     步长按 clientHeight 算（本机 810，innerHeight 是 902，用后者会滚到
     94% 屏，重叠太少）。 */
  var lastPageKeyAt = 0;
  function pageVertical(dir) {
    var se = document.scrollingElement || document.documentElement;
    var down = dir === 'down';
    var before = se.scrollTop;
    var over = se.scrollHeight - se.clientHeight;
    var dy = Math.round((se.clientHeight || innerHeight) * 0.85) * (down ? 1 : -1);
    var target = Math.max(0, Math.min(before + dy, over));
    if (target !== before) {
      /* behavior:'instant' 明确要求立即跳，压过站点可能的
         scroll-behavior:smooth；否则紧接着读 scrollTop 还是旧值，
         会被自己误判成「没滚动」 */
      try { window.scrollTo({ top: target, behavior: 'instant' }); }
      catch (e) { window.scrollTo(0, target); }
      if (se.scrollTop !== before) return;
    }
    /* 滚不动 → 翻页。长按会连发 repeat，这里自己节流，别翻页翻飞 */
    var now = Date.now();
    if (now - lastPageKeyAt < 350) return;
    lastPageKeyAt = now;
    if (down) webKey('ArrowRight', 39);
    else webKey('ArrowLeft', 37);
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
    /* 返回键先关弹层；返回 '1' 表示已消费，Activity 就不再后退。
       正常路径是壳层按 syncPanel 的坐标注入真实触摸，这里是兜底（合成点击，
       面板按钮多数有 isTrusted 守卫，点不动时至少把遮罩/容器关掉） */
    closeModal: function () {
      var p = readerPanel();
      if (p) {
        var el = p.back || p.close;
        if (el) el.click();
        else if (p.mask) p.mask.click();
        syncPanel();
        return '1';
      }
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
               count: targets().length, modal: modalOpen(), panel: !!readerPanel(),
               virgin: state.virgin,
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
      /* 阅读模式上下键：竖屏长页滚一屏，分页排版回退成翻页 */
      case 'pageV':       pageVertical(m.dir); break;
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
