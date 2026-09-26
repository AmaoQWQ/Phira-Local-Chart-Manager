export function auditMarkup(): string {
  return String.raw`<section data-page="audit" hidden><div class="heading"><div><h1>操作记录</h1><p class="muted">显示可查看范围内的操作、原因和变更内容。</p></div><button id="auditReload">加载 / 刷新记录</button></div><div id="auditEvents"></div><button id="auditMore" hidden>加载更早记录</button></section>`;
}
