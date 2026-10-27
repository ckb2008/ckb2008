/*
 * Gitalk 评论 / 预览（Preview）Markdown LaTeX 公式支持 —— KaTeX 版
 * ---------------------------------------------------------------------------
 * 版本：2.0.0（带 CDN 自动切换、轮询兜底与诊断接口）
 *
 * 原理：
 *   GitHub 的 markdown API（POST /markdown）不渲染 LaTeX，公式以纯文本
 *   `$...$` / `$$...$$` 原样返回。Gitalk 的评论正文与编辑框 Preview 都是用
 *   dangerouslySetInnerHTML 把这段 HTML 塞进 `.gt-comment-body` /
 *   `.gt-header-preview` 的。
 *
 * 两个必须解决的关键点：
 *
 *   1) React 更新预览时是「替换容器的子节点」，容器元素本身不变。
 *      所以监听不能只看新增节点自身是否匹配容器，必须向上找最近的容器祖先。
 *
 *   2) GitHub 返回的 $$...$$ 常被 <br> 拆成多个文本节点：
 *        <p>$$<br>\int_0^1 x\,dx<br>$$</p>
 *      KaTeX 的 auto-render 只在单个文本节点内匹配分隔符，块级公式会静默失败
 *      （行内公式不受影响，所以常被误判成「部分公式坏了」）。
 *      渲染前需要做一次同父元素内的 $$ 配对合并。
 *
 * 用法：
 *   <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/gitalk/dist/gitalk.css">
 *   <script src="https://cdn.jsdelivr.net/npm/gitalk/dist/gitalk.min.js"></script>
 *   <script src="gitalk-math.js?v=2"></script>     ← 升级后请改版本号强制刷新缓存
 *
 * 可选配置（写在脚本之前）：
 *   <script>
 *     window.GitalkMathConfig = {
 *       cdn: 'https://fastly.jsdelivr.net/npm/katex@',  // 只用某一个源
 *       version: '0.16.9',
 *       mhchem: true,                                   // 支持 \ce{H2O}
 *       delimiters: [ ... ],
 *     }
 *   </script>
 *
 * 诊断：页面加载后在控制台执行
 *   GitalkMath.debug()
 * 会打印 KaTeX 是否就绪、用了哪个源、预览区当前状态、为什么没渲染。
 */
(function (global) {
  'use strict';

  var VERSION = '2.1.0';
  var KATEX_VERSION = '0.16.9';
  var STYLE_ID = 'gitalk-math-style';
  var STATE_FLAG = '__gitalkMathState';

  /*
   * KaTeX 的多个下载源，按顺序尝试，任何一个成功即可。
   *
   * 顺序是刻意为中文用户排的：国内访问 cdn.jsdelivr.net 经常超时或被污染，
   * 而 fastly.jsdelivr.net（同 CDN 的备用域名）、npmmirror（阿里 npm 镜像）、
   * 360 前端 CDN（lib.baomitu.com）、七牛（cdn.staticfile.org）通常可用。
   *
   * 各源目录布局不同，所以每个资源都用回调给出完整 URL：
   *   - jsDelivr / unpkg：/npm/katex@<ver>/dist/katex.min.js
   *   - npmmirror：/katex/<ver>/files/dist/katex.min.js
   *   - cdnjs / baomitu / staticfile：/<ver>/katex.min.js（没有 dist 目录）
   *
   * 想强制只用一个源（例如自建镜像），设置 window.GitalkMathConfig.cdn。
   */
  var CDN_LIST = [
    {
      name: 'jsdelivr-fastly',
      css: function (v) { return 'https://fastly.jsdelivr.net/npm/katex@' + v + '/dist/katex.min.css'; },
      js: function (v) { return 'https://fastly.jsdelivr.net/npm/katex@' + v + '/dist/katex.min.js'; },
      autoRender: function (v) { return 'https://fastly.jsdelivr.net/npm/katex@' + v + '/dist/contrib/auto-render.min.js'; },
      mhchem: function (v) { return 'https://fastly.jsdelivr.net/npm/katex@' + v + '/dist/contrib/mhchem.min.js'; }
    },
    {
      name: 'npmmirror',
      css: function (v) { return 'https://registry.npmmirror.com/katex/' + v + '/files/dist/katex.min.css'; },
      js: function (v) { return 'https://registry.npmmirror.com/katex/' + v + '/files/dist/katex.min.js'; },
      autoRender: function (v) { return 'https://registry.npmmirror.com/katex/' + v + '/files/dist/contrib/auto-render.min.js'; },
      mhchem: function (v) { return 'https://registry.npmmirror.com/katex/' + v + '/files/dist/contrib/mhchem.min.js'; }
    },
    {
      name: 'baomitu-360',
      css: function (v) { return 'https://lib.baomitu.com/katex/' + v + '/katex.min.css'; },
      js: function (v) { return 'https://lib.baomitu.com/katex/' + v + '/katex.min.js'; },
      autoRender: function (v) { return 'https://lib.baomitu.com/katex/' + v + '/contrib/auto-render.min.js'; },
      mhchem: function (v) { return 'https://lib.baomitu.com/katex/' + v + '/contrib/mhchem.min.js'; }
    },
    {
      name: 'staticfile-7xin',
      css: function (v) { return 'https://cdn.staticfile.org/KaTeX/' + v + '/katex.min.css'; },
      js: function (v) { return 'https://cdn.staticfile.org/KaTeX/' + v + '/katex.min.js'; },
      autoRender: function (v) { return 'https://cdn.staticfile.org/KaTeX/' + v + '/contrib/auto-render.min.js'; },
      mhchem: function (v) { return 'https://cdn.staticfile.org/KaTeX/' + v + '/contrib/mhchem.min.js'; }
    },
    {
      name: 'jsdelivr',
      css: function (v) { return 'https://cdn.jsdelivr.net/npm/katex@' + v + '/dist/katex.min.css'; },
      js: function (v) { return 'https://cdn.jsdelivr.net/npm/katex@' + v + '/dist/katex.min.js'; },
      autoRender: function (v) { return 'https://cdn.jsdelivr.net/npm/katex@' + v + '/dist/contrib/auto-render.min.js'; },
      mhchem: function (v) { return 'https://cdn.jsdelivr.net/npm/katex@' + v + '/dist/contrib/mhchem.min.js'; }
    },
    {
      name: 'unpkg',
      css: function (v) { return 'https://unpkg.com/katex@' + v + '/dist/katex.min.css'; },
      js: function (v) { return 'https://unpkg.com/katex@' + v + '/dist/katex.min.js'; },
      autoRender: function (v) { return 'https://unpkg.com/katex@' + v + '/dist/contrib/auto-render.min.js'; },
      mhchem: function (v) { return 'https://unpkg.com/katex@' + v + '/dist/contrib/mhchem.min.js'; }
    },
    {
      name: 'cdnjs',
      css: function (v) { return 'https://cdnjs.cloudflare.com/ajax/libs/katex/' + v + '/katex.min.css'; },
      js: function (v) { return 'https://cdnjs.cloudflare.com/ajax/libs/katex/' + v + '/katex.min.js'; },
      autoRender: function (v) { return 'https://cdnjs.cloudflare.com/ajax/libs/katex/' + v + '/contrib/auto-render.min.js'; },
      mhchem: function (v) { return 'https://cdnjs.cloudflare.com/ajax/libs/katex/' + v + '/contrib/mhchem.min.js'; }
    }
  ];

  // 每个源的单次加载超时；太长会让用户对着空白预览干等，太短会误杀慢速网络
  var SCRIPT_TIMEOUT = 3000;

  var cfg = {
    version: KATEX_VERSION,
    // 若显式指定 cdn，则只用它（后面自动推导路径）
    cdn: '',
    mhchem: false,
    // 默认选择器同时覆盖 Gitalk（gt-*）与 Gitment（gitment-*）。
    // 都限定在各自容器内，避免误伤博客正文里同样叫 markdown-body 的文章区域
    // （对长文跑一遍 KaTeX 既慢又没必要）。
    selectors: [
      '.gt-comment-body',
      '.gt-header-preview',
      '.gt-container .markdown-body',
      '.gitment-comment-body',
      '.gitment-editor-preview',
      '.gitment-container .markdown-body'
    ],
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true }
    ],
    katexOptions: {
      throwOnError: false,
      strict: 'ignore'
    },
    // 轮询兜底间隔（毫秒）；设 0 关闭
    pollInterval: 400
  };

  var SELECTOR = cfg.selectors.join(',');
  var loaded = false;
  var usedCdn = '';
  var observer = null;
  var pollTimer = null;
  var stats = { attempts: 0, rendered: 0, lastError: '' };

  /* ================================================================== */
  /* 资源加载                                                            */
  /* ================================================================== */

  /*
   * 依次尝试各源。
   *
   * 两个细节很重要：
   *
   * 1) 一旦某个源成功，必须立刻停手，且不能再让其它源的 script 标签继续存活。
   *    因为其它源此时可能已经发起了网络请求，晚一点到达就会用自己的
   *    window.katex 覆盖掉已经就绪的那一份（同名全局变量），甚至把
   *    auto-render 的全局函数覆盖掉，导致渲染时用的是半初始化状态。
   *    所以成功后统一把「失败的、未完成的」script 标签移除。
   *
   * 2) 超时用 SCRIPT_TIMEOUT（3 秒）。七个源串行最坏 21 秒，比 49 秒友好；
   *    而单个 277KB 的 katex.min.js 在正常网络下远小于 3 秒。
   */
  var pendingScripts = [];

  function normalizeCdnBase(base) {
    if (!base) return base;
    return base.charAt(base.length - 1) === '/' ? base : base + '/';
  }

  /*
   * 用户显式配置 cdn 时的描述对象。
   *
   * 支持三种写法：
   *   cdn: 'https://cdn.example.com/katex/'         → 自动拼 "<ver>/dist/..."
   *   cdn: 'https://cdn.example.com/katex@0.16.9/'  → 已含版本，不再拼
   *   cdn: ['/static/katex/', 'https://fastly.jsdelivr.net/npm/katex@']
   *                                                 → 数组，按顺序回落
   *
   * 自建镜像只需保证目录内是 npm 包的 dist 布局：
   *   <base>/<ver>/dist/katex.min.js
   *   <base>/<ver>/dist/katex.min.css
   *   <base>/<ver>/dist/contrib/auto-render.min.js
   */
  function customDescFor(base) {
    var b = normalizeCdnBase(base);
    var hasVersion = /katex@[\d.]+\/$/.test(b) || /\/\d+\.\d+\.\d+\/$/.test(b);
    function u(rel) {
      return hasVersion ? b + rel : b + cfg.version + '/' + rel;
    }
    return {
      name: 'custom(' + b + ')',
      css: function () { return u('dist/katex.min.css'); },
      js: function () { return u('dist/katex.min.js'); },
      autoRender: function () { return u('dist/contrib/auto-render.min.js'); },
      mhchem: function () { return u('dist/contrib/mhchem.min.js'); }
    };
  }

  function customDescs() {
    if (!cfg.cdn) return null;
    var list = Array.isArray(cfg.cdn) ? cfg.cdn : [cfg.cdn];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i]) out.push(customDescFor(list[i]));
    }
    return out.length ? out : null;
  }

  // 取得某个源的某类资源 URL（回调式定义，兼容各 CDN 不同的目录布局）
  function urlOf(desc, kind) {
    var fn = desc[kind];
    return typeof fn === 'function' ? fn(cfg.version) : '';
  }

  var scriptCache = Object.create(null);

  /*
   * 加载一个脚本，带超时。
   *
   * 注意这里不缓存「失败」的结果用于永久拒绝：失败时把 cache 项删掉，
   * 这样 GitalkMath.retry() 能重新尝试同一个 URL（例如用户刚连上代理）。
   */
  function loadScript(src, timeout) {
    if (scriptCache[src]) return scriptCache[src];

    var p = new Promise(function (resolve, reject) {
      var done = false;
      function finish(fn, arg) {
        if (done) return;
        done = true;
        fn(arg);
      }
      var existing = document.querySelector('script[data-src="' + src + '"]');
      if (existing && existing.getAttribute('data-gitalk-math-loaded') === '1') {
        return finish(resolve);
      }
      var s = existing || document.createElement('script');
      if (!existing) s.setAttribute('data-src', src);

      var timer = global.setTimeout(function () {
        finish(reject, new Error('timeout ' + timeout + 'ms: ' + src));
      }, timeout || SCRIPT_TIMEOUT);

      s.addEventListener('load', function () {
        global.clearTimeout(timer);
        s.setAttribute('data-gitalk-math-loaded', '1');
        finish(resolve);
      });
      s.addEventListener('error', function () {
        global.clearTimeout(timer);
        finish(reject, new Error('load failed: ' + src));
      });
      if (!existing) {
        s.src = src;
        s.async = true;
        document.head.appendChild(s);
        pendingScripts.push(s);
      }
    });

    scriptCache[src] = p;
    p.catch(function () { delete scriptCache[src]; });
    return p;
  }

  /*
   * 成功后清理：把所有「没加载成功」的 KaTeX script 标签移走。
   *
   * 不清理的后果：竞速中较慢的那个源在几秒后加载完成，会用它的
   * window.katex 覆盖掉已就绪的那一份。两份 KaTeX 的版本/内部状态
   * 不一致时，renderMathInElement 可能拿到半初始化的实例而静默失败。
   */
  function cleanupFailedScripts() {
    for (var i = pendingScripts.length - 1; i >= 0; i--) {
      var s = pendingScripts[i];
      if (s && s.parentNode && s.getAttribute('data-gitalk-math-loaded') !== '1') {
        // 移除标签可阻止尚未开始的请求；已发出的请求其响应不会再执行
        s.parentNode.removeChild(s);
      }
    }
    pendingScripts.length = 0;
  }

  function loadCSS(href) {
    if (document.querySelector('link[data-gitalk-math]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.setAttribute('data-gitalk-math', '');
    document.head.appendChild(l);
  }

  function tryCdn(desc) {
    var cssUrl = urlOf(desc, 'css');
    var jsUrl = urlOf(desc, 'js');
    var arUrl = urlOf(desc, 'autoRender');

    return loadScript(jsUrl, SCRIPT_TIMEOUT).then(function () {
      if (!global.katex) throw new Error('katex 未挂载: ' + jsUrl);
      return loadScript(arUrl, SCRIPT_TIMEOUT);
    }).then(function () {
      if (typeof global.renderMathInElement !== 'function') {
        throw new Error('renderMathInElement 未挂载: ' + arUrl);
      }
      loadCSS(cssUrl);
      if (cfg.mhchem) {
        return loadScript(urlOf(desc, 'mhchem'), SCRIPT_TIMEOUT).catch(function () {
          if (global.console) global.console.warn('[GitalkMath] mhchem 加载失败，\\ce{} 不可用');
        });
      }
    }).then(function () {
      return desc.name;
    });
  }

  function loadKaTeX() {
    var custom = customDescs();
    var list = custom ? custom.concat(CDN_LIST) : CDN_LIST.slice();

    var i = 0;
    function next() {
      if (i >= list.length) {
        return Promise.reject(new Error('所有 KaTeX CDN 均不可用'));
      }
      var desc = list[i++];
      stats.attempts++;
      return tryCdn(desc).then(function (name) {
        usedCdn = name + ' (' + urlOf(desc, 'js') + ')';
        cleanupFailedScripts();   // 成功后立刻掐掉其它源的残留
        return name;
      }).catch(function (e) {
        stats.lastError = String(e && e.message || e);
        if (global.console) {
          global.console.warn('[GitalkMath] CDN 失败，尝试下一个：' + stats.lastError);
        }
        return next();
      });
    }
    return next();
  }

  /* ================================================================== */
  /* 样式                                                               */
  /* ================================================================== */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.gt-container .katex-display,',
      '.gt-header-preview .katex-display,',
      '.gt-comment-body .katex-display {',
      '  overflow-x: auto;',
      '  overflow-y: hidden;',
      '  padding: 2px 0;',
      '  margin: 0.8em 0;',
      '}',
      '.gt-container .katex { font-size: 1.02em; color: inherit; }',
      '.gt-container .gt-header-preview { min-height: 3em; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ================================================================== */
  /* 渲染                                                               */
  /* ================================================================== */

  function hasTeX(text) {
    return /\$|\\\(|\\\[/.test(text || '');
  }

  /*
   * 收集「公式之外」的文本。
   *
   * 不能直接看 node.textContent 里有没有 $，因为公式渲染后 KaTeX 生成的
   * 节点里也含 $（如 $\Gamma$ 的 annotation 保留原始 LaTeX）。所以必须
   * 跳过 .katex 子树，只看尚未被渲染的文本。
   *
   * 这样也修掉了「部分公式成功、部分失败」的场景：只要还有游离的 $ 存在，
   * 就说明需要再渲染一次，而不是看到第一个 .katex 就整块放弃。
   */
  function textOutsideKatex(node) {
    var out = '';
    function walk(n) {
      if (n.nodeType === 3) { out += n.nodeValue || ''; return; }
      if (n.nodeType !== 1) return;
      if (n.classList && n.classList.contains('katex')) return;
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
    }
    walk(node);
    return out;
  }

  function needsRender(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!node.querySelectorAll) return false;
    return hasTeX(textOutsideKatex(node));
  }

  /* ---- 跨节点 $$ 合并 ---- */

  function isBr(node) {
    return node && node.nodeType === 1 && node.tagName === 'BR';
  }

  // 未被转义的 '$$' 计数（奇数 = 一个未闭合的开标记）
  function countDoubleDollar(text) {
    var n = 0, i = 0;
    while (i < text.length - 1) {
      if (text.charAt(i) === '\\') { i += 2; continue; }
      if (text.charAt(i) === '$' && text.charAt(i + 1) === '$') { n++; i += 2; continue; }
      i++;
    }
    return n;
  }

  function mergeRange(parent, startIdx, endIdx) {
    var parts = [], nodes = [];
    for (var i = startIdx; i <= endIdx; i++) {
      var n = parent.childNodes[i];
      nodes.push(n);
      if (n.nodeType === 3) parts.push(n.nodeValue || '');
      else if (isBr(n)) parts.push('\n');
    }
    var merged = document.createTextNode(parts.join(''));
    parent.insertBefore(merged, parent.childNodes[startIdx]);
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].parentNode === parent) parent.removeChild(nodes[j]);
    }
  }

  function mergeBrokenBlocks(parent) {
    if (!parent || !parent.childNodes || !parent.childNodes.length) return;
    var guard = 0, changed = true;
    while (changed && guard++ < 20) {
      changed = false;
      var children = parent.childNodes;
      var openIdx = -1;
      for (var i = 0; i < children.length; i++) {
        var node = children[i];
        if (node.nodeType === 3) {
          if (countDoubleDollar(node.nodeValue || '') % 2 === 0) continue;
          if (openIdx < 0) { openIdx = i; continue; }
          var ok = true;
          for (var k = openIdx + 1; k < i; k++) {
            var mid = children[k];
            if (mid.nodeType === 1 && !isBr(mid)) { ok = false; break; }
          }
          if (ok) { mergeRange(parent, openIdx, i); changed = true; break; }
          openIdx = -1;
          continue;
        }
        if (node.nodeType === 1) {
          if (isBr(node)) continue;
          openIdx = -1;
        }
      }
    }
  }

  function normalizeBlocks(root) {
    if (!root || !root.querySelectorAll) return;
    mergeBrokenBlocks(root);
    var all = root.querySelectorAll('p, div, li, blockquote, td, h1, h2, h3, h4, h5, h6');
    for (var i = 0; i < all.length; i++) {
      // 只看未被渲染的文本；已经成功的公式不必再进一遍
      if ((textOutsideKatex(all[i]) || '').indexOf('$$') < 0) continue;
      mergeBrokenBlocks(all[i]);
    }
  }

  function renderNode(node) {
    if (typeof global.renderMathInElement !== 'function') return false;
    if (!needsRender(node)) return false;
    try {
      normalizeBlocks(node);
      global.renderMathInElement(node, {
        delimiters: cfg.delimiters,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        ignoredClasses: ['gt-header-textarea', 'katex', 'gt-error'],
        throwOnError: cfg.katexOptions.throwOnError,
        strict: cfg.katexOptions.strict,
        macros: cfg.katexOptions.macros || {},
        errorColor: cfg.katexOptions.errorColor || undefined
      });
      node[STATE_FLAG] = (node[STATE_FLAG] || 0) + 1;
      stats.rendered++;
      return true;
    } catch (e) {
      stats.lastError = String(e && e.message || e);
      if (global.console) global.console.warn('[GitalkMath] 渲染失败：', e);
      return false;
    }
  }

  function containerOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.matches && el.matches(SELECTOR)) return el;
    var p = el.parentElement;
    return p && p.closest ? p.closest(SELECTOR) : null;
  }

  function renderAll(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i++) renderNode(nodes[i]);
  }

  /* ================================================================== */
  /* 变更监听                                                            */
  /* ================================================================== */

  function isKatexOutput(n) {
    if (!n || n.nodeType !== 1) return true;
    if (n.classList && (n.classList.contains('katex') || n.classList.contains('katex-display'))) return true;
    if (n.closest && n.closest('.katex')) return true;
    return false;
  }

  function scanAdded(node) {
    if (!node || node.nodeType !== 1) return;
    if (isKatexOutput(node)) return;
    var self = containerOf(node);
    if (self) renderNode(self);
    if (node.querySelectorAll) {
      var inner = node.querySelectorAll(SELECTOR);
      for (var i = 0; i < inner.length; i++) renderNode(inner[i]);
    }
  }

  function startObserver() {
    if (observer || !('MutationObserver' in global)) return;
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        if (!added || !added.length) continue;
        for (var j = 0; j < added.length; j++) scanAdded(added[j]);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /*
   * 轮询兜底。
   * MutationObserver 在极少数情况下会漏掉预览更新（例如容器被复用、
   * 或预览内容来自缓存、或框架在微任务里既删又加）。每 400ms 轻量扫一遍
   * 「可见的预览区 + 仍含 $ 却无公式」的元素，代价极低（只读 textContent）。
   */
  function sweep() {
    if (document.hidden) return;
    var boxes = document.querySelectorAll('.gt-header-preview, .gt-comment-body');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      // 隐藏的预览区也要处理：一旦显示就不该再等下一次触发
      if (needsRender(box)) renderNode(box);
    }
  }

  function startPolling() {
    if (pollTimer || !cfg.pollInterval) return;
    pollTimer = global.setInterval(sweep, cfg.pollInterval);
  }

  /* ================================================================== */
  /* 初始化                                                             */
  /* ================================================================== */

  function applyOptions(opts) {
    if (!opts) return;
    if (opts.version) cfg.version = opts.version;
    if (opts.cdn) cfg.cdn = opts.cdn;
    if (typeof opts.mhchem === 'boolean') cfg.mhchem = opts.mhchem;
    if (typeof opts.pollInterval === 'number') cfg.pollInterval = opts.pollInterval;
    if (opts.delimiters && opts.delimiters.length) cfg.delimiters = opts.delimiters;
    if (opts.selectors && opts.selectors.length) {
      cfg.selectors = opts.selectors.slice();
      SELECTOR = cfg.selectors.join(',');
    }
    if (opts.katexOptions) {
      for (var k in opts.katexOptions) {
        if (Object.prototype.hasOwnProperty.call(opts.katexOptions, k)) {
          cfg.katexOptions[k] = opts.katexOptions[k];
        }
      }
    }
  }

  function boot() {
    injectStyle();

    // 页面里已经引过 KaTeX + auto-render（比如主题自带）就别重复加载
    if (global.katex && typeof global.renderMathInElement === 'function') {
      loaded = true;
      usedCdn = '(页面已自带 KaTeX，未重复加载)';
      renderAll(document);
      startObserver();
      startPolling();
      if (global.console) {
        global.console.log('[GitalkMath] v' + VERSION + ' 已就绪，复用页面已有的 KaTeX');
      }
      return;
    }

    loadKaTeX().then(function () {
      loaded = true;
      renderAll(document);
      startObserver();
      startPolling();
      if (global.console) {
        global.console.log('[GitalkMath] v' + VERSION + ' 已就绪，KaTeX 源：' + usedCdn);
      }
    }).catch(function (e) {
      stats.lastError = String(e && e.message || e);
      // 即使加载失败也开监听：用户可能稍后用 retry() 补上
      startObserver();
      startPolling();
      if (global.console) {
        global.console.error(
          '[GitalkMath] KaTeX 加载失败，公式无法渲染。\n' +
          '原因：' + stats.lastError + '\n' +
          '→ 请检查网络能否访问 KaTeX CDN，或把 window.GitalkMathConfig.cdn 指向自建镜像。\n' +
          '→ 自建镜像示例：window.GitalkMathConfig = { cdn: "/static/katex/" }（目录内需有 katex.min.js / katex.min.css / contrib/auto-render.min.js）\n' +
          '→ 修好网络后在控制台执行 GitalkMath.retry() 立即重试，无需刷新页面。'
        );
      }
    });
  }

  function debug() {
    var d = document;
    var preview = d.querySelector('.gt-header-preview');
    var info = {
      version: VERSION,
      katexReady: loaded && typeof global.renderMathInElement === 'function',
      usedCdn: usedCdn || '(未加载)',
      lastError: stats.lastError || '(无)',
      renderCount: stats.rendered,
      attempts: stats.attempts,
      katexObject: !!global.katex,
      autoRenderFn: typeof global.renderMathInElement,
      previewExist: !!preview,
      previewVisible: !!preview && !preview.classList.contains('hide'),
      previewHasDollar: !!preview && hasTeX(preview.textContent),
      previewKatexCount: preview ? preview.querySelectorAll('.katex').length : 0,
      commentBodies: d.querySelectorAll('.gt-comment-body').length,
      commentKatexCount: d.querySelectorAll('.gt-comment-body .katex').length
    };
    if (global.console && global.console.table) global.console.table(info);
    else if (global.console) global.console.log(info);
    return info;
  }

  global.GitalkMath = {
    version: VERSION,
    init: function (opts) { applyOptions(opts); },
    renderAll: renderAll,
    renderPreview: function () {
      var p = document.querySelector('.gt-header-preview');
      return p ? renderNode(p) : false;
    },
    retry: function () {
      // 情况一：之前的加载失败了，但页面后来自己出现了 KaTeX（用户手动引了脚本），
      // 直接接管，不再走网络。
      if (!loaded && global.katex && typeof global.renderMathInElement === 'function') {
        loaded = true;
        usedCdn = '(retry 时接管页面已有的 KaTeX)';
        renderAll(document);
        sweep();
        startObserver();
        startPolling();
        return true;
      }
      if (loaded) {
        renderAll(document);
        sweep();
        return true;
      }
      // 情况二：清掉失败缓存，把所有源重新试一遍
      scriptCache = Object.create(null);
      pendingScripts.length = 0;
      stats.attempts = 0;
      boot();
      return true;
    },
    isReady: function () { return loaded && typeof global.renderMathInElement === 'function'; },
    debug: debug,
    options: cfg,
    stats: stats
  };

  if (global.GitalkMathConfig) applyOptions(global.GitalkMathConfig);
  global.GitalkMath.init = function (opts) { applyOptions(opts); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
