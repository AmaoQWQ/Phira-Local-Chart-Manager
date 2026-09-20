/**
 * Admin chart preview, rendered by the vendored phira-web-monitor WASM player.
 *
 * This deliberately contains no notion of what a chart file looks like. It only
 * drives the published `ChartPlayer` API exactly the way the upstream viewer does
 * (`new ChartPlayer(canvasId, apiBase)` → `load_chart(id)` → `resize`/`render` per
 * frame), so a chart is drawn by the same code players see in the monitor instead of
 * by a second, inevitably drifting reimplementation.
 *
 * Three details are worth remembering when touching this file:
 *   - `load_chart` fetches `{apiBase}/chart/{id}` itself and cannot send an admin
 *     token header, so `apiBase` is a same-origin path authenticated by the session
 *     cookie, and the instance ID travels inside that path. Changing instance means
 *     a new player.
 *   - `ChartPlayer` exposes `set_time` but no clock getter, so the progress display is
 *     extrapolated in JavaScript from the last seek or resume. Resuming therefore must
 *     NOT re-seek: `TimeManager` and the audio source already hold the paused position,
 *     and feeding them an extrapolated value is what made pause/resume restart the
 *     chart.
 *   - Reopening the same chart skips `load_chart` entirely. Loading re-downloads and
 *     re-deserialises tens of megabytes of PCM and rebuilds the WebAudio buffer, which
 *     is the entire wait the user sees; the player still holds the previous chart.
 */

/**
 * Volume is a browser-local preference; the key is inlined into the client string below
 * (`phira.preview.volume`), which runs in the page and cannot see this module's scope.
 *
 * Both strings returned here are injected verbatim into the admin page, so their contents
 * must never contain a backtick: it would terminate the template literal they live in.
 */

export function previewDialog(): string {
  return String.raw`<style>
.preview-stage{position:relative;aspect-ratio:16/9;background:#0b1112;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.preview-stage canvas{position:relative;display:block;width:100%;height:100%}
.preview-bg{position:absolute;inset:0;overflow:hidden;background:#0b1112}
.preview-bg[hidden]{display:none}
.preview-bg img{display:block;width:100%;height:100%;object-fit:cover}
.preview-bg-shade{position:absolute;inset:0}
.preview-notice{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;margin:0;color:var(--muted);background:#0b1112}
.preview-notice[hidden]{display:none}
.preview-bar{display:flex;align-items:center;gap:12px;margin-top:14px;flex-wrap:wrap}
.preview-bar #previewSeek{flex:1;min-width:180px}
.preview-bar input[type=range]{padding:0;border:0;background:transparent}
.preview-bar label.check{flex-direction:row;align-items:center;gap:6px;white-space:nowrap}
.preview-bar button{white-space:nowrap}
.preview-volume{gap:8px!important}
.preview-volume input[type=range]{width:104px;flex:0 0 auto}
</style>
<dialog id="previewDialog" aria-labelledby="previewTitle" style="width:min(1180px,calc(100% - 24px))"><div class="dialog-head"><h2 id="previewTitle">谱面预览</h2><button data-close="previewDialog" aria-label="关闭">×</button></div><div class="dialog-body"><div class="preview-stage"><div class="preview-bg" id="previewBackground" hidden><img id="previewBackgroundImage" alt=""><div class="preview-bg-shade" style="background:rgba(0,0,0,0.3)"></div><div class="preview-bg-shade" id="previewBackgroundDim"></div></div><canvas id="previewCanvas"></canvas><p id="previewNotice" class="preview-notice">正在准备渲染器…</p></div><div class="preview-bar"><button id="previewToggle" class="small primary" disabled>播放</button><button id="previewRestart" class="small ghost" disabled>回到开头</button><input id="previewSeek" type="range" min="0" max="1000" step="1" value="0" aria-label="播放进度" disabled><span id="previewClock" class="mono muted">0:00</span><label class="check"><input type="checkbox" id="previewAutoplay" checked> 自动演示</label><label class="check preview-volume"><span class="muted">音量</span><input id="previewVolume" type="range" min="0" max="100" step="1" value="100" aria-label="音量"><span id="previewVolumeLabel" class="mono muted" style="width:42px">100%</span></label></div><p id="previewMeta" class="muted"></p></div></dialog>`;
}

export function previewClient(): string {
  return String.raw`
var PREVIEW={module:null,player:null,instance:'',id:null,loaded:false,raf:0,duration:0,respack:null,respackNote:'',rendererNote:'',assets:null,scrubbing:false,ready:false,offset:0,anchor:null,loading:false,resumeAfterSeek:false,volume:1,pendingSeek:null,silentFrames:0,epoch:0,inflight:null};
function previewNotice(text){var el=$('#previewNotice');if(!el)return;if(text){el.hidden=false;el.textContent=text}else{el.hidden=true;el.textContent=''}}
function previewClock(seconds){var total=Math.max(0,Math.floor(seconds||0));return Math.floor(total/60)+':'+String(total%60).padStart(2,'0')}
function previewBytes(bytes){if(!bytes)return '';var units=['B','KB','MB','GB'],i=0,value=bytes;while(value>=1024&&i<units.length-1){value/=1024;i++}return (i?value.toFixed(1):value)+' '+units[i]}
function previewBase(){return '/api/admin/monitor/i/'+encodeURIComponent(state.instance)}
function previewAssets(){
  if(!PREVIEW.assets){
    PREVIEW.assets=api('/api/admin/monitor/status').then(function(status){
      return {version:typeof status.version==='string'?status.version:'',respack:Array.isArray(status.respack)?status.respack:[]}
    }).catch(function(error){
      console.warn('preview: status request failed',error);
      return {version:'',respack:[]}
    })
  }
  return PREVIEW.assets
}
function previewAssetBase(kind){return previewAssets().then(function(assets){return '/api/admin/monitor/'+kind+'/'+(assets.version?assets.version+'/':'')})}
function previewEngine(){
  if(!PREVIEW.module){
    // The version token dates the renderer build, so a rebuilt WASM can never be
    // shadowed by a cached copy at the same URL.
    PREVIEW.module=previewAssetBase('pkg')
      .then(function(base){return import(base+'monitor_client.js')})
      .then(function(m){return Promise.resolve(m.default()).then(function(){return m})})
  }
  return PREVIEW.module
}
function previewResize(){var canvas=$('#previewCanvas');if(!canvas)return;var box=canvas.parentElement.getBoundingClientRect();var dpr=Math.min(window.devicePixelRatio||1,2);var width=Math.max(1,Math.round(box.width*dpr)),height=Math.max(1,Math.round(box.height*dpr));if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;previewBackgroundBlur()}}
/**
 * The reference player (prpr) builds its background by blurring the illustration with a
 * radius of 50 at the image's own resolution, then scaling it to the screen. Scaling the
 * CSS radius by the same factor keeps the look equivalent whatever the source size is.
 */
function previewBackgroundBlur(){
  var image=$('#previewBackgroundImage');
  if(!image||!image.naturalWidth)return;
  var stage=image.closest('.preview-stage');
  if(!stage)return;
  var box=stage.getBoundingClientRect();
  if(!box.width||!box.height)return;
  var scale=Math.max(box.width/image.naturalWidth,box.height/image.naturalHeight);
  image.style.filter='blur('+Math.max(1,50*scale).toFixed(1)+'px)'
}
/**
 * Layers the chart illustration behind the playfield, mirroring prpr's draw_background:
 * cover-cropped, blurred, a fixed 0.3 black shade, then the chart's own dim factor on top.
 * The WebGL
 * canvas is cleared to transparent so this shows through.
 */
function previewBackground(id,meta){
  var layer=$('#previewBackground'),image=$('#previewBackgroundImage');
  if(!layer||!image)return;
  var extension=meta&&typeof meta.backgroundExtension==='string'?meta.backgroundExtension:'';
  if(!extension||!meta.revision){layer.hidden=true;return}
  var dim=Number(meta.backgroundDim);
  $('#previewBackgroundDim').style.background='rgba(0,0,0,'+(isFinite(dim)?Math.min(1,Math.max(0,dim)):0.6)+')';
  if(image.dataset.revision===meta.revision){layer.hidden=false;previewBackgroundBlur();return}
  image.dataset.revision=meta.revision;
  image.onload=function(){previewBackgroundBlur()};
  image.onerror=function(){layer.hidden=true;console.warn('preview: the chart illustration could not be loaded')};
  layer.hidden=false;
  image.src='/api/admin/monitor/i/'+encodeURIComponent(state.instance)+'/background/'+id+'?v='+encodeURIComponent(meta.revision)
}
function previewPosition(){return PREVIEW.anchor===null?PREVIEW.offset:PREVIEW.offset+(performance.now()-PREVIEW.anchor)/1000}
function previewShowPosition(seconds){$('#previewSeek').value=String(Math.round(seconds*1000));$('#previewClock').textContent=previewClock(seconds)}
async function previewRespack(){
  if(PREVIEW.respack!==null)return PREVIEW.respack;
  PREVIEW.respack={};
  try{
    var assets=await previewAssets();
    if(!assets.respack.length){PREVIEW.respackNote=' · 内置简化贴图（未安装第三方资源包）';return PREVIEW.respack}
    var base='/api/admin/monitor/respack/'+(assets.version?assets.version+'/':'');
    var files={};
    await Promise.all(assets.respack.map(async function(name){
      var response=await fetch(base+encodeURIComponent(name),{credentials:'same-origin'});
      if(!response.ok)throw new Error(name+'（HTTP '+response.status+'）');
      files[name]=new Uint8Array(await response.arrayBuffer())
    }));
    PREVIEW.respack=files
  }catch(error){
    PREVIEW.respackNote=' · 资源包加载失败，已退回内置贴图：'+error.message
  }
  return PREVIEW.respack
}
function previewLoop(){
  cancelAnimationFrame(PREVIEW.raf);
  function step(){
    var player=PREVIEW.player,canvas=$('#previewCanvas');
    if(player&&canvas){
      // Seeking is applied at most once per frame; a slider drag fires far more often.
      if(PREVIEW.pendingSeek!==null){
        var target=PREVIEW.pendingSeek;PREVIEW.pendingSeek=null;
        PREVIEW.offset=target;PREVIEW.anchor=null;
        try{player.set_time(target)}catch(error){console.error('preview seek error',error)}
      }
      try{
        if(!PREVIEW.loading){
          previewResize();
          player.resize(canvas.width,canvas.height);
          player.render()
        }
      }catch(error){console.error('preview render error',error)}
      if(PREVIEW.silentFrames>0&&--PREVIEW.silentFrames===0){
        try{player.set_autoplay($('#previewAutoplay').checked)}catch(error){}
      }
      // While another chart is loading, the canvas would otherwise keep animating the
      // previous chart behind the notice.
      if(PREVIEW.anchor!==null&&!PREVIEW.scrubbing&&PREVIEW.duration>0){
        var position=previewPosition();
        if(position>=PREVIEW.duration){position=PREVIEW.duration;previewPause();PREVIEW.offset=PREVIEW.duration}
        previewShowPosition(position)
      }
    }
    PREVIEW.raf=requestAnimationFrame(step)
  }
  PREVIEW.raf=requestAnimationFrame(step)
}
/**
 * Playing forward makes the player judge every still-unjudged note at or before the new
 * position. After a seek that is the whole skipped range, and in autoplay each of those
 * notes would fire its own hitsound and particle burst at once. With autoplay off the
 * player only records them as Miss, which emits no sound and no particles, so a few
 * frames are enough to settle the range silently before autoplay resumes.
 */
function previewSilentCatchUp(){
  if(!PREVIEW.player)return;
  try{PREVIEW.player.set_autoplay(false)}catch(error){}
  PREVIEW.silentFrames=3
}
function previewPause(){
  var button=$('#previewToggle');
  if(button){button.dataset.playing='0';button.textContent='播放'}
  if(PREVIEW.anchor!==null){PREVIEW.offset=previewPosition()}
  PREVIEW.anchor=null;
  if(PREVIEW.player){try{PREVIEW.player.pause()}catch(error){}}
}
function previewPlay(at){
  PREVIEW.offset=at;PREVIEW.anchor=performance.now();
  var button=$('#previewToggle');
  if(button){button.dataset.playing='1';button.textContent='暂停'}
  previewShowPosition(at)
}
function previewApplyVolume(){
  var percent=Math.round(PREVIEW.volume*100);
  var input=$('#previewVolume');
  if(input)input.value=String(percent);
  var label=$('#previewVolumeLabel');
  if(label)label.textContent=percent+'%';
  if(!PREVIEW.player)return;
  // A missing method means the page is running an older cached renderer build; saying
  // so beats a control that silently does nothing.
  if(typeof PREVIEW.player.set_volume!=='function'){
    PREVIEW.rendererNote=' · 渲染器缺少音量接口，请硬刷新页面一次（Ctrl+Shift+R）';
    console.warn('preview: the loaded renderer has no set_volume; probably a cached wasm build');
    return
  }
  PREVIEW.rendererNote='';
  try{PREVIEW.player.set_volume(PREVIEW.volume)}catch(error){console.warn('preview: set_volume failed',error)}
}
/**
 * Runs the one wasm call that mutates the entire player. load_chart cannot be cancelled
 * and is not re-entrant, so a load that is no longer wanted still has to finish before the
 * next one starts; the caller decides what to do with the result afterwards.
 */
async function previewLoadChart(id){
  var pending=PREVIEW.inflight;
  if(pending){try{await pending}catch(error){}}
  var load=PREVIEW.player.load_chart(String(id));
  PREVIEW.inflight=load;
  var info;
  try{
    info=await load
  }finally{
    if(PREVIEW.inflight===load)PREVIEW.inflight=null
  }
  // The player really holds this chart now, whatever the caller decides to display, which
  // keeps a later preview of the same chart instant even after an abandoned attempt.
  PREVIEW.loaded=true;PREVIEW.id=id;PREVIEW.meta=info;
  return info
}
async function openPreview(id){
  if(PREVIEW.loading)return;
  var dialog=$('#previewDialog');
  if(!dialog.open)dialog.showModal();
  // Shown before anything is awaited, and opaque: otherwise the previous chart stays
  // visible (and keeps rendering) for the whole load.
  previewNotice('正在准备渲染器…');
  // Closing the dialog invalidates this token, so a load nobody waits for any more cannot
  // apply its state over a newer one, and the busy flag is released immediately.
  var epoch=++PREVIEW.epoch;
  var abandoned=function(){return epoch!==PREVIEW.epoch};
  PREVIEW.loading=true;
  var metaUrl='/api/admin/monitor/i/'+encodeURIComponent(state.instance)+'/meta/'+id;
  var chart=state.charts.find(function(c){return c.id===id});
  $('#previewTitle').textContent='谱面预览 · '+(chart?chart.name:'#'+id);
  $('#previewMeta').textContent='';
  $('#previewToggle').disabled=true;$('#previewRestart').disabled=true;$('#previewSeek').disabled=true;$('#previewSeek').max='1000';$('#previewSeek').value='0';$('#previewClock').textContent='0:00';
  previewPause();
  PREVIEW.ready=false;PREVIEW.anchor=null;PREVIEW.duration=0;
  try{
    var module=await previewEngine();
    var pack=await previewRespack();
    if(abandoned())return;
    var instanceChanged=PREVIEW.player&&PREVIEW.instance!==state.instance;
    if(instanceChanged){
      // The player's api base is fixed at construction, so a different instance needs a
      // fresh player; replacing the canvas drops the old WebGL context with it.
      var canvas=$('#previewCanvas'),fresh=canvas.cloneNode(false);
      canvas.replaceWith(fresh);
      PREVIEW.player=null;PREVIEW.loaded=false;PREVIEW.id=null
    }
    if(!PREVIEW.player){
      previewResize();
      PREVIEW.player=new module.ChartPlayer('previewCanvas',previewBase());
      PREVIEW.player.set_autoplay(true);
      PREVIEW.instance=state.instance;
      previewApplyVolume();
      if(Object.keys(pack).length)await PREVIEW.player.load_resource_pack(pack)
    }
    // Suspended while the dialog is closed, so restart the render loop here.
    if(!PREVIEW.raf)previewLoop();
    var sameChart=PREVIEW.loaded&&PREVIEW.id===id;
    // Ask for the summary first: it says whether the payload still has to be compiled, and
    // it carries the illustration metadata the background layer needs.
    var meta={};
    try{meta=await api(metaUrl)}catch(error){}
    if(abandoned())return;
    if(meta.revision)previewBackground(id,meta);
    if(!sameChart){
      // Nothing is waiting for this chart any more, so do not download tens of megabytes.
      if(!dialog.open)return;
      // An abandoned attempt cannot be aborted, only waited out; say so instead of leaving
      // the previous attempt's message on screen.
      if(PREVIEW.inflight)previewNotice('正在结束上一次加载，随后载入该谱面…');
      else previewNotice(meta.ok?'正在加载谱面与音频…':'首次预览需要编译该谱面（解码音频），请稍候…');
      var info=await previewLoadChart(id);
      if(abandoned())return;
      // load_chart seeks the player to zero, so the transport follows it.
      PREVIEW.offset=0;
      // A first preview compiles on demand, so the summary only exists now.
      if(!meta.ok){
        try{meta=await api(metaUrl)}catch(error){}
        if(abandoned())return;
        if(meta.revision)previewBackground(id,meta)
      }
    }
    PREVIEW.duration=Number(meta.duration)||0;
    PREVIEW.ready=true;
    $('#previewSeek').max=String(Math.max(1000,Math.round(PREVIEW.duration*1000)));
    $('#previewSeek').disabled=PREVIEW.duration<=0;
    $('#previewToggle').disabled=false;$('#previewRestart').disabled=false;
    // Reopening the same chart keeps the player where it was paused, so show that.
    previewShowPosition(PREVIEW.offset);
    var info2=PREVIEW.meta;
    var parts=[];
    if(info2&&info2.name)parts.push(info2.name);
    if(info2&&(info2.charter||info2.composer))parts.push(info2.charter||info2.composer);
    // The transport follows the music, and the chart content when it is longer, so both
    // numbers are shown whenever they differ.
    var music=Number(meta.musicSeconds)||0,chartEnd=Number(meta.chartEnd)||0;
    if(music)parts.push('音乐 '+previewClock(music));
    if(chartEnd&&Math.abs(chartEnd-music)>1)parts.push('谱面内容 '+previewClock(chartEnd));
    if(meta.notes)parts.push(meta.notes+' 音符');
    if(meta.bytes)parts.push(previewBytes(meta.bytes));
    if(sameChart)parts.push('已缓存，无需重新加载');
    $('#previewMeta').textContent=parts.join(' · ')+PREVIEW.respackNote+PREVIEW.rendererNote;
    previewNotice(null)
  }catch(error){
    if(abandoned())return;
    previewNotice('预览失败：'+(error&&error.message?error.message:String(error)));
    previewPause()
  }finally{
    // Only the attempt that still owns the flag may clear it.
    if(!abandoned())PREVIEW.loading=false
  }
}
$('#previewToggle').onclick=function(){
  if(!PREVIEW.player||!PREVIEW.ready)return;
  if(this.dataset.playing==='1'){previewPause();return}
  // Continue where the player stopped: TimeManager already holds that position, so
  // re-seeking here is what used to throw the chart back to the beginning.
  if(PREVIEW.offset>=PREVIEW.duration){PREVIEW.player.set_time(0);PREVIEW.offset=0}
  previewSilentCatchUp();
  PREVIEW.player.resume();
  previewPlay(PREVIEW.offset)
};
$('#previewRestart').onclick=function(){
  if(!PREVIEW.player||!PREVIEW.ready)return;
  var playing=$('#previewToggle').dataset.playing==='1';
  if(playing){
    // While playing, render() adopts the audio clock every frame, so seeking alone is
    // undone immediately: the audio source has to be restarted at zero too.
    PREVIEW.player.pause();
    PREVIEW.player.set_time(0);
    previewSilentCatchUp();
    PREVIEW.player.resume();
    previewPlay(0)
  }else{
    PREVIEW.player.set_time(0);
    PREVIEW.offset=0;PREVIEW.anchor=null;
    previewShowPosition(0)
  }
};
$('#previewSeek').oninput=function(){
  if(!PREVIEW.player||!PREVIEW.ready)return;
  var seconds=Number(this.value)/1000;
  if(!PREVIEW.scrubbing){PREVIEW.resumeAfterSeek=PREVIEW.anchor!==null;PREVIEW.scrubbing=true;previewPause()}
  PREVIEW.offset=seconds;PREVIEW.anchor=null;PREVIEW.pendingSeek=seconds;
  $('#previewClock').textContent=previewClock(seconds)
};
$('#previewSeek').onchange=function(){
  if(!PREVIEW.player||!PREVIEW.ready)return;
  PREVIEW.scrubbing=false;
  if(PREVIEW.resumeAfterSeek){previewSilentCatchUp();PREVIEW.player.resume();previewPlay(PREVIEW.offset)}
  PREVIEW.resumeAfterSeek=false
};
$('#previewAutoplay').onchange=function(){if(PREVIEW.player)PREVIEW.player.set_autoplay(this.checked)};
$('#previewVolume').oninput=function(){
  PREVIEW.volume=Math.min(1,Math.max(0,Number(this.value)/100));
  previewApplyVolume();
  storage.set('localStorage','phira.preview.volume',String(Math.round(PREVIEW.volume*100)))
};
$('#previewDialog').addEventListener('close',function(){
  // Invalidate the attempt in flight and release the busy flag at once: load_chart cannot
  // be aborted, but it is serialised and its result is thrown away, so the next preview
  // can be opened immediately instead of being ignored.
  PREVIEW.epoch++;PREVIEW.loading=false;
  previewPause();PREVIEW.ready=false;cancelAnimationFrame(PREVIEW.raf);PREVIEW.raf=0
});
PREVIEW.volume=Math.min(1,Math.max(0,Number(storage.get('localStorage','phira.preview.volume')||100)/100));
previewApplyVolume();
`;
}
