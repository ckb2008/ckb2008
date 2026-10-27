/*
 * Gitalk 评论 Markdown LaTeX 公式支持
 * 原理：GitHub 的 markdown API 不会渲染 LaTeX（公式以纯文本形式返回），
 *       本脚本在浏览器端加载 KaTeX（含 auto-render 扩展），并在 Gitalk
 *       渲染 / 翻页 / 刷新评论后，扫描 .gt-comment-body 与 .markdown-body
 *       中的 $...$ / $$...$$（以及 \( \) / \[ \]）并渲染成公式。
 *
 * 使用方法（在引入 Gitalk 之后引入本脚本即可，无需改动 Gitalk 配置）：
 *   <script src="https://cdn.jsdelivr.net/npm/gitalk/dist/gitalk.min.js"></script>
 *   <script src="gitalk-math.js"></script>
 *
 * 可选：自定义分隔符 / 监听容器
 *   <script>
 *     GitalkMath.init({
 *       delimiters: [
 *         { left: '$$', right: '$$', display: true },
 *         { left: '$',  right: '$',  display: false }
 *       ]
 *     });
 *   </script>
 *
 * 注意：脚本会自动从 jsDelivr 加载 KaTeX 的 CSS / JS，需保证页面可访问该 CDN。
 */
(function (global) {
  'use strict';

  var KATEX_VERSION = '0.16.9';
  var KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@' + KATEX_VERSION + '/dist/katex.min.css';
  var KATEX_JS = 'https://cdn.jsdelivr.net/npm/katex@' + KATEX_VERSION + '/dist/katex.min.js';
  var AUTORENDER_JS = 'https://cdn.jsdelivr.net/npm/katex@' + KATEX_VERSION + '/dist/contrib/auto-render.min.js';

  // 公式分隔符（行内 / 块级），与常见 Markdown 数学写法一致
  var renderOptions = {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true }
    ],
    // 不要渲染代码块 / 输入框里的 $（避免与货币符号冲突等）
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    throwOnError: false
  };

  var RENDERED_FLAG = '__gitalkMathRendered';

  function loadCSS(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  // 注入少量样式：让块级公式在窄屏可横向滚动，避免溢出
  function injectStyle() {
    if (document.getElementById('gitalk-math-style')) return;
    var style = document.createElement('style');
    style.id = 'gitalk-math-style';
    style.textContent = [
      '.gt-container .katex-display {',
      '  overflow-x: auto;',
      '  overflow-y: hidden;',
      '  padding: 4px 0;',
      '  margin: 12px 0;',
      '}',
      '.gt-container .katex { font-size: 1.05em; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function renderIn(node) {
    if (!global.renderMathInElement || !node || node[RENDERED_FLAG]) return;
    try {
      global.renderMathInElement(node, renderOptions);
      node[RENDERED_FLAG] = true;
    } catch (e) { /* 跳过渲染失败的单条评论 */ }
  }

  function renderAll(root) {
    if (!root || !global.renderMathInElement) return;
    var nodes = root.querySelectorAll('.gt-comment-body, .markdown-body');
    for (var i = 0; i < nodes.length; i++) renderIn(nodes[i]);
  }

  function startObserver() {
    if (!('MutationObserver' in global)) {
      // 老旧浏览器：退化为定时扫描
      setInterval(function () { renderAll(document); }, 1000);
      return;
    }
    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var i = 0; i < added.length; i++) {
          var n = added[i];
          if (n.nodeType !== 1) continue;
          if (n.matches && (n.matches('.gt-comment-body') || n.matches('.markdown-body'))) {
            renderIn(n);
          }
          if (n.querySelectorAll) {
            var inner = n.querySelectorAll('.gt-comment-body, .markdown-body');
            for (var j = 0; j < inner.length; j++) renderIn(inner[j]);
          }
        }
      }
    });
    // 观察整个文档的子树变化（覆盖 Gitalk 的动态加载 / 翻页 / 刷新）
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function init(opts) {
    if (opts && opts.delimiters) renderOptions.delimiters = opts.delimiters;
    injectStyle();
    loadCSS(KATEX_CSS);
    Promise.all([loadScript(KATEX_JS), loadScript(AUTORENDER_JS)])
      .then(function () {
        renderAll(document);
        startObserver();
      })
      .catch(function (e) {
        if (global.console) console.warn('[GitalkMath] KaTeX 加载失败，公式未启用：', e);
      });
  }

  global.GitalkMath = { init: init, renderAll: renderAll };

  // 默认自动初始化（若页面已提供 init 调用则幂等：第二次也无害）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})(window);
