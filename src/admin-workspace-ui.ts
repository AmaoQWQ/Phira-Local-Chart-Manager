import { chartsMarkup } from "./admin-page-charts";
import { uploadMarkup } from "./admin-page-upload";
import { recordsMarkup } from "./admin-page-records";
import { instancesMarkup } from "./admin-page-instances";
import { applicationMarkup } from "./admin-page-application";
import { usersMarkup } from "./admin-page-users";
import { auditMarkup } from "./admin-page-audit";
import { settingsMarkup } from "./admin-page-settings";
import { docPickerMarkup } from "./admin-page-docs";
import { roomsMarkup } from "./admin-page-rooms";
import { docsMarkup } from "./admin-page-docs";
export function adminWorkspaceMarkup(): string {
  return String.raw`<div class="shell" id="workspace" hidden>
<a class="skip-link" href="#mainContent">跳转到主要内容</a>
<div class="sidebar-scrim" id="sidebarScrim" hidden></div>
<aside class="sidebar" id="sidebar"><div class="sidebar-head"><div class="brand"><div class="brand-mark" aria-hidden="true">p</div><div><strong>phira</strong><small>LOCAL CHART MANAGER</small></div></div><button type="button" class="sidebar-close ghost" id="sidebarClose" aria-label="关闭导航"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg></button></div><div class="nav-label">内容管理</div><nav class="nav" aria-label="管理导航">
<button data-view="charts" class="active" aria-current="page"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>谱面库<span class="nav-count" id="navCount">—</span></button>
<button data-view="upload"><svg viewBox="0 0 24 24"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></svg>上传谱面</button>
<button data-view="records"><svg viewBox="0 0 24 24"><path d="M5 21V11m7 10V3m7 18V7"/></svg>本地成绩</button>
<button data-view="instances"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M6 6h2m-2 11h2"/></svg>服务实例</button>
<button data-view="rooms" id="roomsNav" hidden><svg viewBox="0 0 24 24"><path d="M4 4h16v12H4z"/><path d="M8 20h8m-4-4v4"/></svg>房间</button>
<div class="nav-label nav-label-secondary">管理与支持</div><nav class="nav" aria-label="管理与支持导航"><button data-view="application" id="applicationNav" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/></svg>注册申请</button><button data-view="users" id="usersNav" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v1"/></svg>用户与审核</button><button data-view="audit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h5"/></svg>操作记录</button><button data-view="docs"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4zM20 4h-3a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h3z"/></svg>使用文档</button><button data-view="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="17" r="2"/></svg>连接与设置</button></nav><div class="sidebar-foot"><span class="status-dot" id="statusDot"></span><span id="connectionState">尚未连接</span><br><span id="sideInstance">本地管理工作区</span></div></aside>
<main class="main" id="mainContent"><header class="topbar"><div class="topbar-leading"><button type="button" class="nav-toggle ghost" id="navToggle" aria-label="打开导航" aria-expanded="false" aria-controls="sidebar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><div class="breadcrumb"><span>管理工作区</span><span>/</span><strong id="crumb">谱面库</strong></div></div><div class="top-actions"><label class="instance-control"><select id="instanceSelect" aria-label="当前服务实例" disabled><option>尚未连接</option></select></label><button class="ghost icon-text" id="reload" title="刷新当前实例数据"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.2 6M20 4v7h-7"/></svg><span>刷新</span></button><button class="ghost top-settings" id="connectionButton">连接设置</button></div></header>
<div class="content"><div class="account-bar"><strong id="accountName"></strong><span class="muted" id="accountQuota" style="margin-left:12px"></span><button id="logoutButton" class="small ghost" style="float:right">退出登录</button></div><div id="loadError" class="callout error" role="alert" hidden></div>
${chartsMarkup()}${uploadMarkup()}${recordsMarkup()}${instancesMarkup()}${applicationMarkup()}${usersMarkup()}${auditMarkup()}${settingsMarkup()}${docPickerMarkup()}${roomsMarkup()}${docsMarkup()}<footer class="page-footer"><span>PHIRA 本地谱面管理系统</span><span id="lastUpdated">等待连接</span></footer></div></main></div>
`;
}
