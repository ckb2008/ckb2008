/*
 * Gitalk 评论 / 预览（Preview）Markdown LaTeX 公式支持 —— KaTeX 版
 * ---------------------------------------------------------------------------
 * 原理：
 *   GitHub 的 markdown API（POST /markdown）不会渲染 LaTeX，公式会以纯文本
 *   `$...$` / `$$...$$` 的形式原样返回。Gitalk 的「评论正文」和「编辑框右下角
 *   Preview 预览」都是用 dangerouslySetInnerHTML 把这段 HTML 塞进
 *   `.gt-comment-body` / `.gt-header-preview` 的。
 *
 *   关键难点（也是 Preview 之前不生效的原因）：
 *   React 更新预览时是**替换容器的子节点**（container.innerHTML = html），
 *   容器元素本身不变、也不会有新节点「本身就是」 .markdown-body。
 *   所以监听必须向上找最近的公式容器祖先，而不是只看新增节点自身。
 *
 *   本脚本的做法：
 *   1) 动态加载 KaTeX（katex.min.css / katex.min.js / contrib/auto-render.min.js）；
 *   2) 用 MutationObserver 监听整棵文档树，任何新增节点都向上查找最近的
 *      `.gt-comment-body` / `.markdown-body` / `.gt-header-preview` 祖先并渲染；
 *   3) 用「容器内是否已存在 .katex」做幂等判断，避免重复渲染已渲染过的正文，
 *      同时保证预览内容被整体替换后能重新渲染；
 *   4) 点击 Preview / Edit 按钮后再补几次延迟扫描，覆盖 axios 往返造成的时序差。
 *
 * 用法（放在 Gitalk 之后即可，无需改 Gitalk 配置）：
 *   <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/gitalk/dist/gitalk.css">
 *   <script src="https://cdn.jsdelivr.net/npm/gitalk/dist/gitalk.min.js"></script>
 *   <script src="gitalk-math.js"></script>
 *
 * 可选配置（全部有默认值）：
 *   GitalkMath.init({
 *     version: '0.16.9',                     // KaTeX 版本
 *     cdn: 'https://cdn.jsdelivr.net/npm/katex@',  // 自定义 CDN 前缀
 *     mhchem: false,                         // 是否加载 mhchem（\ce{} 化学式）
 *     delimiters: [                          // 自定义分隔符
 *       { left: '$$', right: '$$', display: true },
 *       { left: '$',  right: '$',  display: false }
 *     ],
 *     katexOptions: { throwOnError: false, strict: 'ignore', macros: { '\\RR': '\\mathbb{R}' } },
 *     selectors: ['.gt-comment-body', '.markdown-body', '.gt-header-preview']
 *   });
 *   GitalkMath.renderAll();   // 手动全量重扫（例如你自己动态插入了评论）
 *
 * 注意：
 *   - 需要页面能访问 KaTeX 的 CDN（默认 jsDelivr）。
 *   - 行内 `$` 与美元金额冲突时，可在写法上用 `\$`，或去掉 $ 分隔符，
 *     只保留 $$ / \( \) / \[ \]。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    version: '0.16.9',
    cdn: 'https://cdn.jsdelivr.net/npm/katex@',
    mhchem: false,
    // 公式容器：评论正文 / 任意 markdown-body / 编辑框预览
    selectors: ['.gt-comment-body', '.markdown-body', '.gt-header-preview'],
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true }
    ],
    katexOptions: {
      throwOnError: false,
      strict: 'ignore'
    }
  };

  var cfg = {
    version: DEFAULTS.version,
    cdn: DEFAULTS.cdn,
    mhchem: DEFAULTS.mhchem,
    selectors: DEFAULTS.selectors.slice(),
    delimiters: DEFAULTS.delimiters,
    katexOptions: DEFAULTS.katexOptions
  };

  var SELECTOR = cfg.selectors.join(',');
  var STYLE_ID = 'gitalk-math-style';
  var STATE_FLAG = '__gitalkMathState';
  var loaded = false;
  var observer = null;

  /* ------------------------------------------------------------------ */
  /* 资源加载                                                            */
  /* ------------------------------------------------------------------ */

  function katexCSS() {
    return cfg.cdn + cfg.version + '/dist/katex.min.css';
  }
  function katexJS() {
    return cfg.cdn + cfg.version + '/dist/katex.min.js';
  }
  function autoRenderJS() {
    return cfg.cdn + cfg.version + '/dist/contrib/auto-render.min.js';
  }
  function mhchemJS() {
    return cfg.cdn + cfg.version + '/dist/contrib/mhchem.min.js';
  }

  function loadCSS(href) {
    if (document.querySelector('link[data-gitalk-math], link[href="' + href + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.setAttribute('data-gitalk-math', '');
    document.head.appendChild(l);
  }

  // 同名脚本只加载一次；返回 Promise，并发调用会共享同一份加载
  var scriptCache = Object.create(null);
  function loadScript(src) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.getAttribute('data-gitalk-math-loaded') === '1') return resolve();
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error('load failed: ' + src)); });
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () {
        s.setAttribute('data-gitalk-math-loaded', '1');
        resolve();
      };
      s.onerror = function () { reject(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }

  /* ------------------------------------------------------------------ */
  /* 样式：预览区与正文区的公式排版                                      */
  /* ------------------------------------------------------------------ */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      /* 块级公式在窄屏下横向滚动，避免撑破评论区 */
      '.gt-container .katex-display,',
      '.gt-header-preview .katex-display,',
      '.gt-comment-body .katex-display {',
      '  overflow-x: auto;',
      '  overflow-y: hidden;',
      '  padding: 2px 0;',
      '  margin: 0.8em 0;',
      '}',
      '.gt-container .katex { font-size: 1.02em; }',
      /* 预览区高度留白，避免公式异步渲染前后跳动过大 */
      '.gt-container .gt-header-preview { min-height: 3em; }',
      /* 渲染失败（如未加载完）时公式不闪烁：先按文本正常显示即可，无需额外处理 */
      /* 暗色主题下公式颜色跟随文字色，KaTeX 默认 currentColor，这里兜底一次 */
      '.gt-container .katex { color: inherit; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                            */
  /* ------------------------------------------------------------------ */

  function hasTeX(text) {
    return /\$|\\\(|\\\[/.test(text || '');
  }

  // 幂等判断：容器内已经有 .katex 说明渲染过（且内容没被整体替换）
  function needsRender(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!node.querySelectorAll) return false;
    if (node.querySelector('.katex')) return false;
    return hasTeX(node.textContent);
  }

  /* ------------------------------------------------------------------ */
  /* 跨节点的块级公式归一化                                              */
  /* ------------------------------------------------------------------ */
  /*
   * KaTeX auto-render 只在**单个文本节点**内匹配分隔符。而 GitHub markdown API
   * 返回的 $$...$$ 块常常是：
   *     <p>$$<br>\int ... <br>$$</p>
   * 或换行被渲染成 <br>，导致开头的 $$ 和结尾的 $$ 落在不同文本节点，
   * 块级公式就渲染不出来。
   *
   * 这里在渲染前做一次「同父元素内的 $$ 配对修复」：把两个 $$ 之间的 <br>
   * 换成换行文本，并把区间内的文本节点合并成一个，使 auto-render 能识别。
   * 只在不含其它非 br 元素、且两端确实配有 $$ 时才动手，避免误改结构。
   */

  var SKIP_TAGS = { PRE: 1, CODE: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };

  function isBr(node) {
    return node && node.nodeType === 1 && node.tagName === 'BR';
  }

  function isWhitespaceText(node) {
    return node && node.nodeType === 3 && !/\S/.test(node.nodeValue || '');
  }

  // 统计未被反斜杠转义的 '$$' 出现次数（奇数表示一个未闭合的开标记）
  function countDoubleDollar(text) {
    var n = 0;
    var i = 0;
    while (i < text.length - 1) {
      if (text.charAt(i) === '\\') { i += 2; continue; }
      if (text.charAt(i) === '$' && text.charAt(i + 1) === '$') { n++; i += 2; continue; }
      i++;
    }
    return n;
  }

  function mergeRange(parent, startIdx, endIdx) {
    var parts = [];
    var nodes = [];
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

  // 修复单个父元素里被拆开的 $$...$$（可处理多组）
  function mergeBrokenBlocks(parent) {
    if (!parent || !parent.childNodes || !parent.childNodes.length) return;

    var guard = 0;
    var changed = true;
    while (changed && guard++ < 20) {
      changed = false;
      var children = parent.childNodes;
      var openIdx = -1;

      for (var i = 0; i < children.length; i++) {
        var node = children[i];

        if (node.nodeType === 3) {
          var c = countDoubleDollar(node.nodeValue || '');
          if (c % 2 === 0) continue;

          if (openIdx < 0) {
            openIdx = i;
            continue;
          }

          // 找到闭合：中间允许文本节点与 <br>，不允许其它元素
          var ok = true;
          for (var k = openIdx + 1; k < i; k++) {
            var mid = children[k];
            if (mid.nodeType === 1 && !isBr(mid)) { ok = false; break; }
          }
          if (ok) {
            mergeRange(parent, openIdx, i);
            changed = true;
            break;
          }
          openIdx = -1;
          continue;
        }

        if (node.nodeType === 1) {
          if (isBr(node)) continue;          // <br> 可以跨越
          openIdx = -1;                       // 其它元素打断配对
        }
      }
    }
  }

  function normalizeBlocks(root) {
    if (!root || !root.querySelectorAll) return;
    // 先处理根自身作为父节点的情况
    mergeBrokenBlocks(root);
    var all = root.querySelectorAll('p, div, li, blockquote, td, h1, h2, h3, h4, h5, h6');
    for (var i = 0; i < all.length; i++) {
      if (all[i].querySelector('.katex')) continue;
      if ((all[i].textContent || '').indexOf('$$') < 0) continue;
      mergeBrokenBlocks(all[i]);
    }
  }

  function renderNode(node) {
    if (!global.renderMathInElement) return false;
    if (!needsRender(node)) return false;
    try {
      normalizeBlocks(node);
      global.renderMathInElement(node, {
        delimiters: cfg.delimiters,
        // 不要动代码块 / 输入框里的 $（避免误伤货币、shell 变量等）
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        ignoredClasses: ['gt-header-textarea', 'katex', 'gt-error'],
        throwOnError: cfg.katexOptions.throwOnError,
        strict: cfg.katexOptions.strict,
        macros: cfg.katexOptions.macros || {},
        errorColor: cfg.katexOptions.errorColor || undefined
      });
      node[STATE_FLAG] = (node[STATE_FLAG] || 0) + 1;
      return true;
    } catch (e) {
      if (global.console) global.console.warn('[GitalkMath] 渲染失败：', e);
      return false;
    }
  }

  // 向上找最近的公式容器（React 替换子节点时需要它）
  function containerOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.matches && el.matches(SELECTOR)) return el;
    if (el.closest) {
      var p = el.parentElement;
      return p && p.closest ? p.closest(SELECTOR) : null;
    }
    return null;
  }

  function renderAll(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i++) renderNode(nodes[i]);
  }

  /* ------------------------------------------------------------------ */
  /* 变更监听                                                            */
  /* ------------------------------------------------------------------ */

  // 我们自己渲染产生的节点（KaTeX 输出）不应触发再次渲染
  function isKatexOutput(n) {
    if (!n || n.nodeType !== 1) return true; // 文本节点、注释等一律忽略
    if (n.classList && (n.classList.contains('katex') || n.classList.contains('katex-display'))) return true;
    if (n.closest && n.closest('.katex')) return true;
    return false;
  }

  function scanAdded(node) {
    if (!node || node.nodeType !== 1) return;
    if (isKatexOutput(node)) return;

    // 1) 新增节点自己就是公式容器（整块被替换 / 首次插入）
    var self = containerOf(node);
    if (self) { renderNode(self); }

    // 2) 新增节点内部包含公式容器（例如整段评论列表被换掉）
    if (node.querySelectorAll) {
      var inner = node.querySelectorAll(SELECTOR);
      for (var i = 0; i < inner.length; i++) renderNode(inner[i]);
    }
  }

  function startObserver() {
    if (observer) return;
    if (!('MutationObserver' in global)) {
      // 老旧浏览器：退化为定时扫描
      global.setInterval(function () { renderAll(document); }, 1000);
      return;
    }
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        if (!added || !added.length) continue;
        for (var j = 0; j < added.length; j++) scanAdded(added[j]);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ */
  /* Preview 按钮兜底：axios 往返完成后补扫几次                          */
  /* ------------------------------------------------------------------ */

  var PREVIEW_TRIGGER = '.gt-btn-preview, .gt-header-controls, .gt-header-preview';

  function sweepPreview() {
    var box = document.querySelector('.gt-header-preview');
    if (box) renderNode(box);
  }

  function bindPreviewFallback() {
    if (document.documentElement.getAttribute('data-gitalk-math-click') === '1') return;
    document.documentElement.setAttribute('data-gitalk-math-click', '1');

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      // 点击 Preview / Edit 按钮，或点击预览区本身（复制公式时重新渲染不会有害）
      if (!t.closest(PREVIEW_TRIGGER)) return;
      // axios POST /markdown 是异步的：立刻、短延时、长延时各扫一次
      sweepPreview();
      global.setTimeout(sweepPreview, 120);
      global.setTimeout(sweepPreview, 400);
      global.setTimeout(sweepPreview, 1000);
      global.setTimeout(sweepPreview, 2500);
    }, true);
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  function applyOptions(opts) {
    if (!opts) return;
    if (opts.version) cfg.version = opts.version;
    if (opts.cdn) cfg.cdn = opts.cdn;
    if (typeof opts.mhchem === 'boolean') cfg.mhchem = opts.mhchem;
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

  function init(opts) {
    applyOptions(opts);
    injectStyle();
    loadCSS(katexCSS());

    var chain = Promise.all([loadScript(katexJS())]);
    if (cfg.mhchem) {
      // mhchem 依赖 KaTeX 已加载
      chain = chain.then(function () { return loadScript(mhchemJS()); });
    }
    chain
      .then(function () { return loadScript(autoRenderJS()); })
      .then(function () {
        loaded = true;
        renderAll(document);
        startObserver();
        bindPreviewFallback();
      })
      .catch(function (e) {
        if (global.console) {
          global.console.warn('[GitalkMath] KaTeX 加载失败，公式未启用（请检查 CDN 可达性）：', e);
        }
      });
  }

  global.GitalkMath = {
    init: init,
    renderAll: renderAll,
    renderPreview: sweepPreview,
    isReady: function () { return loaded && !!global.renderMathInElement; },
    options: cfg
  };

  // 允许在本脚本之前定义 window.GitalkMathConfig = {...} 来预设参数
  // （自动初始化会先应用它，再用 init(opts) 的显式参数覆盖）
  if (global.GitalkMathConfig) applyOptions(global.GitalkMathConfig);

  // 默认自动初始化（重复调用 init 是幂等的）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
