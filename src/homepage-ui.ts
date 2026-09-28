import { phiraThemeCss } from "./ui-theme";

/** Self-contained landing page; no CDN, third-party scripts or external assets. */
export function homepageUi(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="index,follow">
<title>Phira 本地谱面管理系统</title>
<script>(function(){try{var theme=localStorage.getItem('phira-color-scheme');if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme}catch(_){}})();</script>
<style>
${phiraThemeCss()}
:root{
  font-family:Inter,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  color:var(--text);
  background:var(--bg);
  --px:0;
  --py:0;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  background:var(--bg);
  color:var(--text);
  font-size:16px;
  overflow-x:hidden;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
a,button,input,select,textarea{-webkit-tap-highlight-color:transparent}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:3px;border-radius:6px}

/* Pointer-reactive backdrop -------------------------------------------------- */
.scene{
  position:fixed;
  inset:0;
  z-index:0;
  overflow:hidden;
  pointer-events:none;
  background:
    radial-gradient(100vmax 68vmax at 78% 0%,var(--ambient-cyan),transparent 62%),
    radial-gradient(82vmax 66vmax at 10% 92%,var(--ambient-purple),transparent 66%),
    var(--bg);
}
.scene-grid{
  position:absolute;
  left:-24vmax;
  top:-24vmax;
  right:-24vmax;
  bottom:-24vmax;
  opacity:.9;
  background-image:
    linear-gradient(to right,var(--grid-line) 1px,transparent 1px),
    linear-gradient(to bottom,var(--grid-line) 1px,transparent 1px);
  background-size:64px 64px;
  -webkit-mask-image:radial-gradient(ellipse 95% 82% at 50% 44%,#000 0%,rgba(0,0,0,.55) 55%,transparent 82%);
  mask-image:radial-gradient(ellipse 95% 82% at 50% 44%,#000 0%,rgba(0,0,0,.55) 55%,transparent 82%);
  transform:translate3d(calc(var(--px,0)*-42px),calc(var(--py,0)*-26px),0) rotate(calc(var(--px,0)*-.45deg));
  transition:transform .6s cubic-bezier(.22,1,.36,1);
  will-change:transform;
}

/* Page layout ---------------------------------------------------------------- */
.page{
  position:relative;
  z-index:1;
  min-height:100vh;
  min-height:100dvh;
  display:flex;
  flex-direction:column;
}
.topbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:26px clamp(20px,5vw,48px);
}
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:9px 13px;border:1px solid var(--glass-border);border-radius:10px;background:var(--bg);color:var(--text);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.theme-toggle:hover{background:var(--bg);border-color:var(--accent)}
.theme-toggle [data-theme-icon]{font-size:18px;line-height:1}
.brand{
  display:inline-flex;
  align-items:center;
  color:var(--text);
  text-decoration:none;
}
.brand-text strong{
  display:block;
  font-size:19px;
  line-height:1.1;
  letter-spacing:.4px;
  font-weight:650;
}
.brand-text small{
  display:block;
  margin-top:3px;
  font-size:9px;
  letter-spacing:.08em;
  color:var(--muted);
}
.side-note{
  color:var(--muted);
  font-size:11px;
  letter-spacing:2.4px;
  text-transform:uppercase;
}

main{
  flex:1;
  display:grid;
  place-items:center;
  text-align:center;
  padding:26px clamp(20px,5vw,48px) 42px;
}
.copy{
  max-width:880px;
  display:flex;
  flex-direction:column;
  align-items:center;
  padding:clamp(28px,5vw,56px);
  border:1px solid var(--glass-border);
  border-radius:28px;
  background:var(--panel);
  -webkit-backdrop-filter:blur(18px) saturate(125%);
  backdrop-filter:blur(18px) saturate(125%);
  box-shadow:0 24px 80px var(--glass-shadow);
  animation:hero-in .5s ease-out both;
}
h1{
  margin:0;
  font-size:clamp(36px,5.2vw,62px);
  line-height:1.22;
  font-weight:680;
  letter-spacing:-.5px;
  text-wrap:balance;
  animation:hero-in .5s ease-out .1s both;
}
h1 .no-break{
  display:inline-block;
  white-space:nowrap;
}
.lead{
  max-width:600px;
  margin:24px 0 0;
  color:var(--text-secondary);
  font-size:clamp(15px,1.4vw,17px);
  line-height:1.8;
  animation:hero-in .5s ease-out .15s both;
}
.action{
  margin-top:44px;
  display:flex;
  flex-direction:column;
  align-items:center;
  animation:hero-in .5s ease-out .2s both;
}
.cta{
  position:relative;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:10px;
  min-height:52px;
  padding:0 24px;
  border-radius:12px;
  background:var(--action-bg);
  border:1px solid var(--action-bg);
  color:var(--on-action);
  font-size:16px;
  font-weight:650;
  line-height:1;
  text-decoration:none;
  box-shadow:0 16px 46px var(--glass-shadow);
  transition:background .15s ease-out,transform .15s ease-out,box-shadow .15s ease-out;
}
.cta svg{
  width:17px;
  height:17px;
  stroke:var(--on-action);
  stroke-width:2;
  fill:none;
  stroke-linecap:round;
  stroke-linejoin:round;
  transition:transform .15s ease-out;
}
.cta:hover{
  background:var(--action-bg);
  border-color:var(--action-bg);
  transform:translateY(-1px);
  box-shadow:0 20px 56px var(--glass-shadow);
}
.cta:hover svg{transform:translateX(3px)}
.cta:active{transform:translateY(0)}
.hint{
  margin:16px 0 0;
  color:var(--muted);
  font-size:12px;
  line-height:1.7;
}

.page-footer{
  padding:18px clamp(20px,5vw,48px) 26px;
  text-align:center;
  color:var(--muted);
  font-size:11px;
  letter-spacing:1.8px;
  text-transform:uppercase;
  animation:hero-in .6s ease-out .3s both;
}
.page-footer span{margin:0 10px;opacity:.7}

@keyframes hero-in{
  from{opacity:0;transform:translateY(12px)}
  to{opacity:1;transform:translateY(0)}
}

/* Small screens -------------------------------------------------------------- */
@media (max-width:700px){
  .topbar{padding-top:20px}
  .topbar{gap:12px}
  .side-note{display:none}
  main{padding-top:6px;padding-bottom:30px}
  h1{font-size:clamp(34px,11.2vw,40px);line-height:1.3}
  .lead{margin-top:18px;line-height:1.75}
  .action{margin-top:34px}
  .page-footer{font-size:9px;letter-spacing:1.4px}
  .copy{padding:30px 22px;border-radius:22px}
  .theme-toggle{min-height:42px;padding:7px 10px;font-size:12px}
}
@media (max-width:360px){
  h1{font-size:33px}
}

/* Motion preferences --------------------------------------------------------- */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{
    animation:none!important;
    transition:none!important;
  }
  .scene-grid{
    transform:none;
  }
}
</style>
</head>
<body>
<div class="scene" id="scene" aria-hidden="true">
  <div class="scene-grid"></div>
</div>

<div class="page">
  <header class="topbar">
    <a class="brand" href="/" aria-label="Phira Local Chart Manager">
      <span class="brand-text">
        <strong>Phira</strong>
        <small>Local Chart Manager</small>
      </span>
    </a>
    <span class="side-note">本地谱面服务</span>
    <button type="button" class="theme-toggle" data-theme-toggle aria-label="切换到深色模式"><span data-theme-icon aria-hidden="true">☾</span><span data-theme-label>深色模式</span></button>
  </header>

  <main>
    <div class="copy">
      <h1>Phira 本地谱面<span class="no-break">管理系统</span></h1>
      <p class="lead">管理本地谱面、成绩和多人房间。</p>
      <div class="action">
        <a class="cta" href="/admin">
          进入管理面板
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h13M13 6l6 6-6 6"/>
          </svg>
        </a>
        <p class="hint">新账号需审核通过后才能创建实例。</p>
      </div>
    </div>
  </main>

  <footer class="page-footer">
    <span>本地谱面</span><span>·</span><span>本地成绩</span><span>·</span><span>多人房间</span>
  </footer>
</div>

<script>
'use strict';
(function () {
  var root = document.documentElement;
  var themeKey = 'phira-color-scheme';
  function currentTheme() {
    return root.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function syncThemeButtons() {
    var active = currentTheme();
    var nextLabel = active === 'dark' ? '浅色模式' : '深色模式';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      var icon = button.querySelector('[data-theme-icon]');
      var label = button.querySelector('[data-theme-label]');
      button.setAttribute('aria-label', '切换到' + nextLabel);
      if (icon) icon.textContent = active === 'dark' ? '☼' : '☾';
      if (label) label.textContent = nextLabel;
    });
  }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      root.dataset.theme = currentTheme() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(themeKey, root.dataset.theme); } catch (_) {}
      syncThemeButtons();
    });
  });
  syncThemeButtons();
  var reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceQuery.matches || !window.matchMedia('(pointer: fine)').matches) return;

  var frame = null;
  var targetX = 0;
  var targetY = 0;
  var currentX = 0;
  var currentY = 0;

  function tick() {
    currentX += (targetX - currentX) * 0.1;
    currentY += (targetY - currentY) * 0.1;
    root.style.setProperty('--px', currentX.toFixed(4));
    root.style.setProperty('--py', currentY.toFixed(4));
    if (Math.abs(targetX - currentX) > 0.0004 || Math.abs(targetY - currentY) > 0.0004) {
      frame = requestAnimationFrame(tick);
    } else {
      frame = null;
    }
  }

  function move(event) {
    targetX = (event.clientX / window.innerWidth) * 2 - 1;
    targetY = (event.clientY / window.innerHeight) * 2 - 1;
    if (frame === null) frame = requestAnimationFrame(tick);
  }

  function reset() {
    targetX = 0;
    targetY = 0;
    if (frame === null) frame = requestAnimationFrame(tick);
  }

  window.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('pointerleave', reset, { passive: true });
  window.addEventListener('blur', reset);
}());
</script>
</body>
</html>`;
}
