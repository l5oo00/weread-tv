/* WeReadTV 扩展后台：把壳从外部文件读出的 tv.js 动态注册为 content script。
 *
 * 为什么不用 manifest.content_scripts：它只能写扩展包内相对路径，而内置扩展
 * 是 GeckoView 直接从 APK 里读的（installBuiltIn 只认 resource://android），
 * 改外部文件碰不到它。改成 background 每次启动调用官方的
 * browser.contentScripts.register，js:[{code}] 被引擎转成 blob: URL，
 * 走和标准 content script 完全相同的注入管线：document_start 保留，
 * connectNative 特权由扩展权限决定、与脚本来源无关。
 *
 * 注册的是那一刻的代码快照：只刷新页面仍是旧代码，重启 App 才会重读外部文件。
 */
'use strict';

const port = browser.runtime.connectNative('weread_tv_bg');

port.onMessage.addListener(async (m) => {
  if (!m || m.op !== 'script') return;
  try {
    await browser.contentScripts.register({
      matches: ['*://weread.qq.com/*', '*://*.weread.qq.com/*'],
      js: [{ code: m.src }],
      runAt: 'document_start'
    });
    port.postMessage({ ev: 'ready' });
  } catch (e) {
    port.postMessage({ ev: 'scriptError', error: String(e) });
  }
});

port.postMessage({ ev: 'needScript' });
