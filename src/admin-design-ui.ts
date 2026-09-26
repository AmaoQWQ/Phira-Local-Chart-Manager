/** Shared visual layer for the self-contained administration page. */
export function adminDesignCss(): string {
  return String.raw`
:root{
  --radius-sm:8px;--radius:12px;--radius-lg:18px;
  --space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;
  --space-5:20px;--space-6:24px;--space-8:32px;
  color:var(--text);background:var(--bg);font-size:16px;line-height:1.5
}
html{min-width:320px;scroll-padding-top:88px}
body{min-width:320px;overflow-x:hidden;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
button,input,select,textarea{font-size:14px}
button,.button,summary{touch-action:manipulation}
button,.button{min-height:44px;border-radius:var(--radius-sm);transition:background-color .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease}
button:active:not(:disabled){filter:brightness(1.08)}
button.small,.button.small{min-height:44px;font-size:13px;padding:9px 12px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
button.primary:hover:not(:disabled){background:var(--accent-hover)}
button.ghost:hover:not(:disabled){background:var(--control)}
button.danger{color:var(--danger);background:var(--danger-surface)}
button.danger:hover:not(:disabled){background:#493033;border-color:#9c5d62}
input,select,textarea{min-height:44px;border-color:#455859;border-radius:var(--radius-sm);background:var(--input);color:var(--text)}
input[type=checkbox]{min-height:auto;width:18px;height:18px;flex:0 0 18px}
input::placeholder,textarea::placeholder{color:#92a3a4}
label{font-size:14px;color:var(--text-secondary);font-weight:500}
label small{font-weight:400}
:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
h1{font-size:clamp(27px,2.3vw,36px);letter-spacing:-.035em;line-height:1.2;font-weight:680}
h2{font-size:18px;line-height:1.35;font-weight:650}
h3{font-size:16px;line-height:1.4}
.muted,small,.help{color:var(--muted)}
.shell{grid-template-columns:244px minmax(0,1fr)}
.sidebar{background:var(--surface);padding:24px 12px 18px;z-index:20;overflow-y:auto;scrollbar-width:thin}
.sidebar-head{display:flex;align-items:center;justify-content:space-between;padding:0 10px}
.brand{padding:0;gap:12px}
.brand-mark{width:34px;height:38px;font-size:21px}
.brand strong{font-size:22px;letter-spacing:-.04em;line-height:1}
.brand small{font-size:9px;letter-spacing:.15em;color:var(--muted);margin-top:6px}
.nav-label{padding:0 16px;margin:35px 0 10px;color:var(--muted);font-size:11px;letter-spacing:.09em;font-weight:650}
.nav-label-secondary{margin-top:30px}
.nav{gap:4px;overflow:visible}
.nav button{width:100%;min-height:44px;padding:10px 14px;font-size:14px;color:var(--text-secondary);border-radius:9px;gap:13px;transition:background-color .16s,color .16s}
.nav button:hover:not(:disabled){background:#202c2e;color:var(--text)}
.nav button.active{background:#263e34;border-color:#3b5f4e;color:#c4f4df;font-weight:650}
.nav svg,.icon-text svg,.nav-toggle svg,.sidebar-close svg{width:19px;height:19px;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;fill:none;flex:none}
.nav-count{font-size:11px}
.check-hit{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;cursor:pointer;margin:-10px}
.check-hit input{margin:0}
.sidebar-foot{margin:24px 10px 0;padding:19px 8px 0;border-top:1px solid var(--line);font-size:12px;line-height:1.7}
.main{width:100%;min-width:0}
.topbar{min-height:78px;padding:12px clamp(20px,3vw,42px);background:rgba(16,22,23,.97);border-bottom:1px solid var(--line);backdrop-filter:none}
.topbar-leading{display:flex;align-items:center;gap:12px;min-width:0}
.breadcrumb{font-size:13px;white-space:nowrap}
.breadcrumb span:first-child{color:var(--muted)}
.breadcrumb strong{color:var(--text);font-weight:620}
.top-actions{gap:12px}
.instance-control{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--muted);white-space:nowrap}
.instance-control select{width:215px;max-width:215px;min-height:44px;font-size:13px;font-weight:600;color:var(--text)}
.top-actions button{min-height:44px}
.icon-text{gap:8px}
.nav-toggle,.sidebar-close{display:none}
.content{max-width:1500px;padding:32px clamp(20px,3vw,42px) 56px}
.account-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;margin-bottom:28px;background:var(--surface);border-color:var(--line);border-radius:var(--radius)}
.account-bar strong{font-size:13px}
.account-bar .muted{margin-left:0!important;font-size:12px}
.account-bar #logoutButton{float:none!important;margin-left:auto}
.heading{margin-bottom:24px;align-items:flex-end;flex-wrap:wrap}
.heading .muted{font-size:14px;line-height:1.6;max-width:66ch}
.heading button{flex:none}
.stats{gap:10px;margin-bottom:24px}
.stat{background:var(--panel);border-color:var(--line);border-radius:var(--radius);padding:19px 20px}
.stat strong{font-size:28px;font-weight:680;line-height:1.15;margin:10px 0 6px;color:var(--text)}
.stat small{color:var(--text-secondary)}
.stat .stat-note{font-size:12px;color:var(--muted)}
.panel{background:var(--panel);border-radius:var(--radius);margin-bottom:20px}
.panel-head{padding:18px 20px}
.panel-head small{font-size:12px}
.panel-body{padding:22px}
.toolbar{padding:16px 20px;gap:10px}
.toolbar .search{min-width:230px}
.batch{padding:13px 20px}
.batch strong{font-size:13px}
.table-scroll{max-height:none}
table{font-size:13px}
th{background:#151f20;color:var(--text-secondary);font-size:12px;font-weight:600;padding:13px 16px}
td{padding:15px 16px;border-color:var(--line);line-height:1.5}
td:first-child,th:first-child{padding-left:20px}
.chart-name{font-size:14px;color:var(--text);font-weight:620}
.chart-sub{font-size:12px;color:var(--muted)}
.badge{border-radius:6px;font-size:12px;padding:4px 8px}
.badge.level{background:#353e3d;color:#d8e8e3}
.badge.green{background:#254336;color:#c4f4df}
.switch{min-height:44px;font-size:12px;font-weight:600;border-radius:8px}
.row-actions{flex-wrap:wrap;align-items:center;gap:8px}
.row-actions button{min-height:44px}
.empty{padding:56px 24px!important}
.empty strong{font-size:15px;color:var(--text)}
.pagination{padding:15px 20px;font-size:13px}
.pagination-controls button{min-width:44px}
.callout{font-size:14px;border-radius:var(--radius);line-height:1.65}
.callout.error{color:#ffd0d0}
.dropzone{background:#1b2b26;border-color:#527564;border-radius:var(--radius);padding:32px 22px}
.dropzone input{max-width:520px}
.instance-grid{gap:12px}
.instance-card{padding:20px;border-radius:var(--radius)}
.instance-card.current{border-color:#8ac8a9;box-shadow:inset 3px 0 0 #a9e8cc}
.settings-layout{max-width:880px}
.settings-layout .panel .panel{margin:20px 0 0;background:var(--surface)}
.danger-zone{border-color:#704345}
.danger-zone .panel-head{border-color:#704345}
dialog{width:min(680px,calc(100vw - 32px));max-height:min(90vh,900px);border-radius:var(--radius-lg);background:var(--panel);border-color:#50615d;box-shadow:0 24px 80px #000a}
dialog::backdrop{background:#050b0bd9;backdrop-filter:blur(3px)}
.dialog-head{padding:18px 22px;position:sticky;top:0;z-index:2;background:var(--panel)}
.dialog-body{padding:22px;overflow:auto;max-height:calc(90vh - 72px)}
.dialog-head button{min-width:44px;min-height:44px;padding:8px;font-size:24px}
.toast{font-size:14px;border-radius:var(--radius)}
.toast button{min-width:36px;min-height:36px}
.auth-gate{min-height:100dvh;padding:40px 20px;background:radial-gradient(ellipse 80% 60% at 50% -15%,#254337 0,transparent 70%),var(--bg)}
.auth-card{width:min(560px,100%);padding:clamp(24px,4vw,42px);background:var(--panel);border-color:#496356;border-radius:var(--radius-lg);box-shadow:0 24px 75px #0005}
.auth-card h1{font-size:clamp(28px,3vw,38px);line-height:1.15}
.auth-tabs{margin:26px 0 24px;padding:4px;gap:4px;background:var(--input);border:1px solid var(--line);border-radius:10px}
.auth-tabs button{flex:1;border:0;background:transparent}
.auth-tabs button.primary{background:var(--accent)}
.auth-form{gap:16px}
.auth-form button[type=submit]{width:100%;margin-top:4px}
.details summary{min-height:44px;display:flex;align-items:center}
.page-footer{font-size:12px;color:var(--muted)}
.sidebar-scrim{display:none}
.skip-link{position:fixed;top:8px;left:8px;z-index:80;padding:11px 16px;background:var(--accent);color:var(--on-accent);border-radius:8px;transform:translateY(-160%);text-decoration:none;font-weight:650}
.skip-link:focus{transform:translateY(0)}
@media(max-width:1150px){
  .shell{grid-template-columns:210px minmax(0,1fr)}
  .sidebar{padding-left:9px;padding-right:9px}
  .topbar{padding-inline:22px}
  .content{padding-inline:22px}
  .top-settings{display:none}
}
@media(max-width:800px){
  .shell{display:block}
  .sidebar{position:fixed;inset:0 auto 0 0;width:min(312px,calc(100vw - 48px));height:100dvh;padding:22px 14px 20px;transform:translateX(-105%);transition:transform .22s ease;box-shadow:16px 0 50px #0007;z-index:40}
  .shell.nav-open .sidebar{transform:translateX(0)}
  .sidebar-scrim:not([hidden]){display:block;position:fixed;inset:0;z-index:39;background:#030808b8}
  .sidebar-head{padding:0 4px}
  .sidebar-close,.nav-toggle{display:inline-flex;min-width:44px;padding:8px}
  .brand small,.nav-label,.sidebar-foot{display:block}
  .nav{flex-direction:column;overflow:visible}
  .nav button{font-size:14px;padding:10px 14px}
  .nav svg{display:block;width:19px;height:19px}
  .topbar{position:sticky;top:0;min-height:70px;padding:10px 18px}
  .breadcrumb{display:flex}
  .breadcrumb span:first-child,.breadcrumb span:nth-child(2){display:none}
  .top-actions{width:auto;justify-content:flex-end}
  .instance-control select{width:min(34vw,190px);max-width:min(34vw,190px)}
  .content{padding:24px 18px 52px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .heading{align-items:flex-start}
  .panel-head,.toolbar,.panel-body{padding:16px}
  .toolbar select{max-width:none}
}
@media(max-width:700px){
  html{scroll-padding-top:74px}
  .content{padding:20px 16px 46px}
  .topbar{padding:9px 12px;gap:8px}
  .topbar-leading{gap:4px}
  .breadcrumb strong{font-size:14px}
  .top-actions{gap:5px}
  .instance-control select{width:126px;max-width:126px;font-size:12px;padding-inline:7px}
  .icon-text{min-width:44px;padding:8px}
  .icon-text span{display:none}
  .heading{gap:16px;margin-bottom:20px}
  .heading .muted{font-size:13px}
  .heading>.row-actions{width:100%}
  .heading>.row-actions button{flex:1}
  .stat{padding:16px}
  .stat strong{font-size:25px}
  .stat .stat-note{font-size:11px}
  .account-bar{align-items:flex-start;gap:4px 10px;margin-bottom:22px}
  .account-bar strong,.account-bar .muted{width:calc(100% - 92px)}
  .account-bar #logoutButton{margin-left:auto;order:2;align-self:center}
  .toolbar .search{flex-basis:100%;min-width:0}
  .toolbar select{flex:1 1 calc(50% - 8px);min-width:0;font-size:13px}
  .row-actions{gap:6px}
  [data-page=records] .table-scroll,[data-page=users] .table-scroll,[data-page=rooms] .table-scroll{overflow:visible}
  [data-page=records] table,[data-page=records] tbody,[data-page=users] table,[data-page=users] tbody,[data-page=rooms] table,[data-page=rooms] tbody{display:block;white-space:normal}
  [data-page=records] thead,[data-page=users] thead,[data-page=rooms] thead{display:none}
  #records tr,#users tr,#rooms tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:18px 16px;border-bottom:1px solid var(--line)}
  #records td,#users td,#rooms td{display:block;padding:0;border:0;min-width:0;overflow-wrap:anywhere;white-space:normal}
  #records td::before,#users td::before,#rooms td::before{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}
  #records td:first-child,#users td:first-child,#rooms td:first-child{grid-column:1/-1;font-weight:600}
  #records td:last-child,#users td:last-child,#rooms td:last-child{grid-column:1/-1}
  #records td:nth-child(2)::before{content:'谱面'}#records td:nth-child(3)::before{content:'分数'}#records td:nth-child(4)::before{content:'准确率'}#records td:nth-child(5)::before{content:'状态'}#records td:nth-child(6)::before{content:'时间'}
  #users td:nth-child(2)::before{content:'角色'}#users td:nth-child(3)::before{content:'已用实例'}#users td:nth-child(4)::before{content:'实例配额'}#users td:nth-child(5)::before{content:'状态'}
  #rooms td:nth-child(2)::before{content:'谱面'}#rooms td:nth-child(3)::before{content:'状态'}#rooms td:nth-child(4)::before{content:'玩家'}#rooms td:nth-child(5)::before{content:'房主'}#rooms td:nth-child(6)::before{content:'实例'}
  #charts tr{grid-template-columns:44px minmax(0,1fr)!important;gap:10px 12px!important}
  #charts td:nth-child(2){grid-column:2!important}
  #charts td:nth-child(n+3){grid-column:2!important;grid-row:auto!important}
  #charts .row-actions,#records .row-actions,#users .row-actions,#rooms .row-actions{width:100%}
  #charts .row-actions button,#records .row-actions button,#users .row-actions button,#rooms .row-actions button{min-height:44px}
  .batch{position:sticky;bottom:0;z-index:6;padding:12px 16px;box-shadow:0 -10px 24px #0007}
  .form-grid,.form-grid.three{gap:16px}
  .form-actions{flex-wrap:wrap}
  .form-actions button{flex:1}
  dialog{width:100vw;max-width:none;max-height:94dvh;margin:auto 0 0;border-radius:18px 18px 0 0;border-bottom:0}
  .dialog-body{max-height:calc(94dvh - 68px);padding:18px 16px calc(24px + env(safe-area-inset-bottom))}
  .dialog-head{padding:12px 16px}
  #permissionsDialog{width:100vw!important}
  .toast-stack{right:12px;bottom:calc(12px + env(safe-area-inset-bottom));width:calc(100vw - 24px)}
  .auth-gate{padding:18px 12px;place-items:start center}
  .auth-card{margin:auto 0;padding:24px 20px}
}
@media(min-width:701px) and (max-width:800px){
  #charts tr{grid-template-columns:44px minmax(0,1fr) auto!important}
}
@media(max-width:390px){
  .instance-control select{width:110px;max-width:110px}
  .content{padding-inline:12px}
  .heading>.primary{width:100%}
  .stats{gap:8px}
  .stat{padding:13px}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}
}
`;
}
