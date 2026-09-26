import { adminBaseCss } from "./admin-base-ui";
import { adminDesignCss } from "./admin-design-ui";
import { adminAuthMarkup } from "./admin-auth-ui";
import { adminWorkspaceMarkup } from "./admin-workspace-ui";
import { adminDialogMarkup } from "./admin-dialogs-ui";
import { adminClient } from "./admin-client-ui";
import { phiraThemeCss } from "./ui-theme";

/** Self-contained admin console; no CDN, third-party scripts or credential-bearing asset URLs. */
export function adminUi(): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Phira 本地谱面管理系统</title>
<style>${phiraThemeCss()}${adminBaseCss()}${adminDesignCss()}</style></head>
<body>${adminAuthMarkup()}${adminWorkspaceMarkup()}${adminDialogMarkup()}
<script>${adminClient()}</script></body></html>`;
}
