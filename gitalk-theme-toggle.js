/*
 * Gitalk 亮/暗切换按钮
 * 依赖：gitalk-autodark.css（三种状态类由它定义）
 *
 * 三种状态：
 *   auto  -> 跟随系统设置（默认）
 *   dark  -> 强制暗色
 *   light -> 强制亮色
 * 状态写入 localStorage('gitalk-theme')，并在 <html> 上加对应 class。
 *
 * 用法（任选其一）：
 *   A. 自动插入一个按钮（最简单）：在 Gitalk 渲染之后调用 GitalkThemeToggle.mount()
 *      <script src="gitalk-theme-toggle.js"></script>
 *      <script>GitalkThemeToggle.mount();</script>
 *
 *   B. 用你自己的按钮/链接，给它加 data-gitalk-theme-toggle 属性即可：
 *      <button data-gitalk-theme-toggle>切换主题</button>
 *      脚本会自动接管点击，把按钮文案更新为当前状态。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'gitalk-theme';
  var CLASS_AUTO = 'gitalk-theme-auto';
  var CLASS_DARK = 'gitalk-theme-dark';
  var CLASS_LIGHT = 'gitalk-theme-light';

  // 状态顺序，点击循环切换
  var ORDER = ['auto', 'light', 'dark'];
  var LABELS = {
    auto: '跟随系统',
    light: '亮色',
    dark: '暗色'
  };

  function getSavedState() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return ORDER.indexOf(v) >= 0 ? v : null;
    } catch (e) {
      return null;
    }
  }

  // 当前系统是否为深色
  function systemPrefersDark() {
    return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function apply(state) {
    var root = document.documentElement; // <html>
    root.classList.remove(CLASS_AUTO, CLASS_DARK, CLASS_LIGHT);
    if (state === 'dark') {
      root.classList.add(CLASS_DARK);
    } else if (state === 'light') {
      root.classList.add(CLASS_LIGHT);
    } else {
      root.classList.add(CLASS_AUTO);
    }
    // 同步所有带 data 属性的按钮文案
    var nodes = document.querySelectorAll('[data-gitalk-theme-toggle]');
    for (var i = 0; i < nodes.length; i++) {
      updateButtonLabel(nodes[i], state);
    }
  }

  function updateButtonLabel(btn, state) {
    // 按钮内部若有一个 .label 元素则只更新它，否则更新整体
    var labelEl = btn.querySelector('.label');
    var text = LABELS[state] || state;
    if (labelEl) {
      labelEl.textContent = text;
    } else {
      btn.textContent = text;
    }
  }

  function currentState() {
    var root = document.documentElement;
    if (root.classList.contains(CLASS_DARK)) return 'dark';
    if (root.classList.contains(CLASS_LIGHT)) return 'light';
    return 'auto';
  }

  function cycle() {
    var cur = currentState();
    var idx = ORDER.indexOf(cur);
    var next = ORDER[(idx + 1) % ORDER.length];
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    apply(next);
  }

  function init(state) {
    apply(state);
    // 点击任意带属性的元素都触发切换
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-gitalk-theme-toggle]') : null;
      if (!t) return;
      // 避免影响内部链接
      if (e.target.closest('a[href]')) return;
      e.preventDefault();
      cycle();
    });
  }

  function mount() {
    // 读取已保存状态，没有则默认 auto（跟随系统）
    var saved = getSavedState() || 'auto';

    // 若页面上已有带 data 属性的按钮，直接接管
    var existing = document.querySelectorAll('[data-gitalk-theme-toggle]');
    if (existing.length) {
      init(saved);
      return;
    }

    // 否则自动插入一个浮动按钮到页面右下角
    var btn = document.createElement('button');
    btn.setAttribute('data-gitalk-theme-toggle', '');
    btn.type = 'button';
    btn.textContent = LABELS[saved] || saved;
    btn.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:99999',
      'padding:8px 14px',
      'border:1px solid rgba(127,127,127,0.3)',
      'border-radius:999px',
      'background:rgba(127,127,127,0.15)',
      'color:inherit',
      'font-size:13px',
      'line-height:1',
      'cursor:pointer',
      'backdrop-filter:blur(6px)',
      '-webkit-backdrop-filter:blur(6px)',
      'box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    ].join(';');
    document.body.appendChild(btn);
    init(saved);
  }

  var api = {
    mount: mount,
    toggle: cycle,
    setState: function (s) {
      if (ORDER.indexOf(s) < 0) return;
      try { localStorage.setItem(STORAGE_KEY, s); } catch (e) {}
      apply(s);
    },
    getState: currentState
  };

  // 暴露全局
  global.GitalkThemeToggle = api;

  // 若以纯脚本方式引入且未发现 jQuery 之类的 DOM 就绪钩子，简化在 DOM 后挂载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      // 仅在用户显式调用 mount() 时才插入按钮；这里不自动插入，避免重复。
    });
  }
})(window);
