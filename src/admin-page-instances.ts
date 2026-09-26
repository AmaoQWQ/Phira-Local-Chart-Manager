export function instancesMarkup(): string {
  return String.raw`<section data-page="instances" hidden><div class="heading"><div><h1>服务实例</h1><p class="muted">各实例的数据互不共用。</p></div><button class="primary" id="createInstance">＋ 创建实例</button></div><div class="instance-grid" id="instanceCards"></div></section>
`;
}
