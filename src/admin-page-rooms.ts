export function roomsMarkup(): string {
  return String.raw`<section data-page="rooms" hidden><div class="heading"><div><h1>多人房间</h1></div><div class="row-actions"><button id="createReservedRoom" class="ghost">＋ 预约白名单房</button><button id="createHostedRoom" class="primary">＋ 托管房</button><button id="roomsReload" class="small">刷新</button></div></div><div id="roomsStatus" class="callout" role="status"></div><div class="panel"><div class="table-scroll"><table><thead><tr><th>房间 / 类型</th><th>谱面</th><th>状态</th><th>玩家</th><th>房主</th><th>实例</th><th>操作</th></tr></thead><tbody id="rooms"></tbody></table></div></div><p class="help" style="padding:0 22px 18px">托管房会在空房和服务重启后保留；预约白名单房用于一次性组局，完整成员到齐并准备后由服务端自动开始。</p></section>
`;
}
