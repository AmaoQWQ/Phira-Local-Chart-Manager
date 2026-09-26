# Phira 网页 UI 设计系统

## 设计方向

管理界面是高密度工作台：深色背景、薄荷绿主操作、清晰的数据层级。首页沿用同一品牌色与字体，但保留更宽松的展示节奏。视觉规则以 `docs/frontend-refactor-handoff.md` 为准，并结合 ui-ux-pro-max 的可访问性、触控、排版与响应式建议。技能库给出的通用蓝绿仪表盘配色不适合本项目，因此没有采用。

## 单一色彩来源

`src/ui-theme.ts` 保存首页和管理页共用的语义色彩：页面、次级背景、面板、控件、输入、主强调、文字、边框、危险与焦点。页面样式应引用这些 token，避免在新组件中增加随意的颜色值。默认使用 Inter、Segoe UI、Microsoft YaHei 和系统字体，不加载公网字体。

## 页面与控件

- 桌面端使用侧栏分组导航、明确的当前实例选择器、顶部刷新和账户状态；手机和平板使用可通过按钮、遮罩和 Escape 关闭的抽屉。
- 谱面库、成绩、用户和房间采用一致的标题、工具栏、状态与操作区域。桌面保留数据表，窄屏转换为分组行。危险操作保持独立的红色按钮和原有二次确认。
- 表单保留可见标签；按钮与输入至少 44px 高；焦点轮廓可见。状态用文字与颜色共同表达。
- 对话框在手机上靠近全屏 sheet，仍保留标题、关闭按钮、原生 Escape 与键盘操作。
- 页面支持 360px、390px、768px 与 1440px 宽度；`prefers-reduced-motion` 关闭非必要动画。

## 代码边界

`src/admin-ui.ts` 只组装完整 HTML。`src/admin-auth-ui.ts`、`src/admin-workspace-ui.ts`、`src/admin-dialogs-ui.ts` 与 `src/admin-page-*.ts` 维护标记；`src/admin-client-ui.ts` 保留统一状态、会话和 API 入口；`src/admin-policy-ui.ts` 与 `src/admin-preview-ui.ts` 继续负责权限原因与 WASM 预览。`src/admin-base-ui.ts` 保存迁移前的样式合同，`src/admin-design-ui.ts` 在其后实现当前设计层。最终响应仍然自包含，不增加前端打包或第三方浏览器依赖。
