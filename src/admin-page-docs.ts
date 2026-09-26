export function docPickerMarkup(): string {
  return String.raw`<dialog id="docDialog" aria-labelledby="docDialogTitle"><div class="dialog-head"><h2 id="docDialogTitle">使用文档</h2><button data-close="docDialog" aria-label="关闭">×</button></div><div class="dialog-body"><div class="doc-options"><button class="doc-option" data-doc="user"><strong>用户接入指南</strong><small>USER.md · 连接和使用说明</small></button><button class="doc-option" data-doc="api"><strong>API 文档</strong><small>API.md · 管理接口与客户端接口参考</small></button></div></div></dialog>
`;
}
export function docsMarkup(): string {
  return String.raw`<section data-page="docs" hidden><div class="heading"><div><h1 id="docHeading">使用文档</h1><p class="muted" id="docIntro"></p></div><div class="row-actions"><button class="primary" id="docPrint">打印 / 另存为 PDF</button><button class="ghost" id="docBack">返回</button></div></div><div id="docStatus" class="callout" role="status" hidden></div><div id="docContent"></div><div id="docLoading" hidden>正在加载文档…</div></section>
`;
}
