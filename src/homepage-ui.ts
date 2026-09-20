/** Self-contained landing page; no CDN, third-party scripts or external assets. */
export function homepageUi(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="index,follow">
<title>Phira 本地谱面管理系统</title>
<style>
:root{
  font-family:Inter,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  color:#e9efef;
  background:#101617;
  --px:0;
  --py:0;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  background:#101617;
  color:#e9efef;
  font-size:16px;
  overflow:hidden;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
a,button,input,select,textarea{-webkit-tap-highlight-color:transparent}
a{color:var(--accent,#a9e8cc)}
:focus-visible{outline:2px solid #c4f4df;outline-offset:3px;border-radius:6px}

/* Pointer-reactive backdrop -------------------------------------------------- */
.scene{
  position:fixed;
  inset:0;
  z-index:0;
  overflow:hidden;
  pointer-events:none;
  background:
    radial-gradient(120vmax 62vmax at 50% -18%, rgba(62,99,84,.24), transparent 62%),
    linear-gradient(165deg,#151e1f 0%,#101617 52%,#0d1213 100%);
}
.scene-grid{
  position:absolute;
  left:-24vmax;
  top:-24vmax;
  right:-24vmax;
  bottom:-24vmax;
  opacity:.9;
  background-image:
    linear-gradient(to right,rgba(169,232,204,.10) 1px,transparent 1px),
    linear-gradient(to bottom,rgba(169,232,204,.10) 1px,transparent 1px);
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
  height:100vh;
  height:100dvh;
  display:flex;
  flex-direction:column;
  overflow:hidden;
}
.topbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:26px clamp(20px,5vw,48px);
}
.brand{
  display:inline-flex;
  align-items:center;
  gap:13px;
  color:#e9efef;
  text-decoration:none;
}
.brand-mark{
  width:34px;
  height:38px;
  background:#a9e8cc;
  clip-path:polygon(28% 0,100% 0,72% 100%,0 100%);
  display:grid;
  place-items:center;
  color:#16362b;
  font-size:19px;
  font-weight:800;
  line-height:1;
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
  letter-spacing:2.8px;
  color:#92a3a4;
  text-transform:uppercase;
}
.side-note{
  color:#748788;
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
  animation:hero-in .5s ease-out both;
}
.eyebrow{
  display:inline-flex;
  align-items:center;
  gap:12px;
  margin:0 0 22px;
  color:#a9e8cc;
  font-size:11px;
  font-weight:600;
  letter-spacing:.32em;
  text-transform:uppercase;
  animation:hero-in .5s ease-out .05s both;
}
.eyebrow::before{
  content:"";
  width:30px;
  height:1px;
  background:linear-gradient(90deg,transparent,rgba(169,232,204,.8));
}
.eyebrow::after{
  content:"";
  width:30px;
  height:1px;
  background:linear-gradient(90deg,rgba(169,232,204,.8),transparent);
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
  color:#c0cecf;
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
  background:#a9e8cc;
  border:1px solid #a9e8cc;
  color:#16362b;
  font-size:16px;
  font-weight:650;
  line-height:1;
  text-decoration:none;
  box-shadow:0 16px 46px rgba(169,232,204,.12);
  transition:background .15s ease-out,transform .15s ease-out,box-shadow .15s ease-out;
}
.cta svg{
  width:17px;
  height:17px;
  stroke:#16362b;
  stroke-width:2;
  fill:none;
  stroke-linecap:round;
  stroke-linejoin:round;
  transition:transform .15s ease-out;
}
.cta:hover{
  background:#c4f4df;
  border-color:#c4f4df;
  transform:translateY(-1px);
  box-shadow:0 20px 56px rgba(169,232,204,.16);
}
.cta:hover svg{transform:translateX(3px)}
.cta:active{transform:translateY(0)}
.hint{
  margin:16px 0 0;
  color:#92a3a4;
  font-size:12px;
  line-height:1.7;
}

.page-footer{
  padding:18px clamp(20px,5vw,48px) 26px;
  text-align:center;
  color:#748788;
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
  .side-note{display:none}
  main{padding-top:6px;padding-bottom:30px}
  h1{font-size:clamp(34px,11.2vw,40px);line-height:1.3}
  .eyebrow{gap:8px;letter-spacing:.22em;margin-bottom:18px}
  .eyebrow::before,.eyebrow::after{width:18px}
  .lead{margin-top:18px;line-height:1.75}
  .action{margin-top:34px}
  .page-footer{font-size:9px;letter-spacing:1.4px}
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
    <a class="brand" href="/" aria-label="Phira 本地谱面管理系统首页">
      <span class="brand-mark" aria-hidden="true">p</span>
      <span class="brand-text">
        <strong>phira</strong>
        <small>LOCAL CHART MANAGER</small>
      </span>
    </a>
    <span class="side-note">本地谱面服务</span>
  </header>

  <main>
    <div class="copy">
      <p class="eyebrow">PHIRA LOCAL CHART MANAGER</p>
      <h1>Phira 本地谱面<span class="no-break">管理系统</span></h1>
      <p class="lead">连接 Phira 客户端，在统一入口中管理本地谱面、成绩与多人房间。</p>
      <div class="action">
        <a class="cta" href="/admin">
          进入管理面板
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h13M13 6l6 6-6 6"/>
          </svg>
        </a>
        <p class="hint">登录或注册账号，审核通过后即可创建与管理自己的谱面空间</p>
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
