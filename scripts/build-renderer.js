// Build the chart renderer (WASM) and the chart compiler (native CLI) from the
// MIT-licensed phira-web-monitor sources.
//
//   node scripts/build-renderer.js [--clone-only] [--skip-wasm] [--skip-cli] [--respack]
//
// Environment:
//   RENDERER_SRC   clone location (default: <repo>/../phira-web-monitor-hsn)
//
// Outputs into <repo>/vendor/renderer/ :
//   pkg/         WASM renderer (js + .wasm) served by the gateway
//   bin/         chart-compiler executable (PEZ -> bincode(ChartInfo, Chart))
//   respack/     optional resource pack; NOT built by default, see --respack
//
// The chart compiler reuses monitor-proxy's parser sources (copied verbatim, together
// with their sibling directory) and the same monitor-common, so it is copied into the
// clone as its own crate with an empty [workspace] table. That keeps cargo from also
// selecting monitor-proxy, whose phira-mp-common enables the Unix-only `stream` feature.
//
// Upstream source patches are applied by patchUpstream(): the player has no volume API
// and connects audio straight to the output, so a single GainNode is inserted and
// `set_volume` is exposed on both AudioEngine and ChartPlayer; its clear colour is made
// transparent so the chart illustration can be layered underneath the canvas; and the
// hold head is exempted from the below-line clip so a held hold keeps its cap.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rendererSrc = path.resolve(process.env.RENDERER_SRC || path.join(repoRoot, '..', 'phira-web-monitor-hsn'));
const vendorRoot = path.join(repoRoot, 'vendor', 'renderer');
const upstream = 'https://github.com/HyperSynapseNetwork/phira-web-monitor.git';
const compilerSrc = path.join(repoRoot, 'tools', 'chart-compiler');
const flags = new Set(process.argv.slice(2));

function run(command, args, options = {}) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function which(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : null;
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** Replaces one exact upstream snippet, refusing to guess when the text has changed. */
function patchFile(relative, replacements) {
  const filePath = path.join(rendererSrc, relative);
  let text = fs.readFileSync(filePath, 'utf8');
  // Clone checkouts on Windows use CRLF, so the snippets below are written with \n and
  // translated to the file's own line ending before matching.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const native = (snippet) => snippet.split('\n').join(eol);
  for (const [anchor, replacement] of replacements) {
    if (!text.includes(native(anchor))) {
      throw new Error(`cannot patch ${relative}: the upstream source no longer contains this anchor:\n---\n${anchor}---\nUpdate scripts/build-renderer.js to match the new upstream code.`);
    }
    text = text.split(native(anchor)).join(native(replacement));
  }
  fs.writeFileSync(filePath, text, 'utf8');
}

/**
 * The upstream player has no volume control at all: every source connects straight to
 * the audio destination. The preview needs one, so the build adds a single gain stage.
 * Running `git checkout` first means the patch is always applied to pristine sources
 * and never stacks up across builds.
 */
function patchUpstream() {
  const files = ['monitor-client/Cargo.toml', 'monitor-client/src/audio.rs', 'monitor-client/src/chart_player.rs', 'monitor-client/src/renderer.rs', 'monitor-client/src/engine/note.rs'];
  const reset = spawnSync('git', ['checkout', '--', ...files], { cwd: rendererSrc, stdio: 'inherit', windowsHide: true });
  if (reset.status !== 0) throw new Error('cannot reset the renderer sources with git checkout');
  patchFile('monitor-client/Cargo.toml', [
    ['    "GainNode",\n', '    "GainNode",\n    "AudioParam",\n'],
  ]);
  patchFile('monitor-client/src/audio.rs', [
    ['    ctx: AudioContext,\n', '    ctx: AudioContext,\n    gain: web_sys::GainNode,\n'],
    [
      '        let ctx = AudioContext::new()?;\n        Ok(Self {\n            ctx,\n',
      '        let ctx = AudioContext::new()?;\n        // Preview patch: one gain stage between every source and the output.\n        let gain = ctx.create_gain()?;\n        gain.connect_with_audio_node(&ctx.destination())?;\n        Ok(Self {\n            ctx,\n            gain,\n',
    ],
    [
      '            // Explicitly cast to BaseAudioContext to access destination()\n            let base_ctx: &web_sys::BaseAudioContext = self.ctx.as_ref();\n',
      '',
    ],
    ['            let base_ctx: &web_sys::BaseAudioContext = self.ctx.as_ref();\n', ''],
    ['            source.connect_with_audio_node(&base_ctx.destination())?;\n', '            source.connect_with_audio_node(&self.gain)?;\n'],
    [
      '    pub fn set_offset(&mut self, offset: f32) {\n        self.offset = offset;\n    }\n',
      '    pub fn set_offset(&mut self, offset: f32) {\n        self.offset = offset;\n    }\n\n    /// Preview patch: attenuates music and hitsounds together.\n    pub fn set_volume(&mut self, volume: f32) {\n        self.gain.gain().set_value(volume);\n    }\n',
    ],
  ]);
  patchFile('monitor-client/src/renderer.rs', [
    [
      '    pub fn clear(&self) {\n        self.context.clear(0.1, 0.1, 0.1, 1.0);\n    }\n',
      '    pub fn clear(&self) {\n        // Preview patch: the canvas is composited over the chart illustration, so it must\n        // not paint an opaque background of its own.\n        self.context.clear(0.0, 0.0, 0.0, 0.0);\n    }\n',
    ],
  ]);
  patchFile('monitor-client/src/chart_player.rs', [
    [
      '    pub fn set_autoplay(&mut self, flag: bool) {\n        self.chart_renderer.autoplay = flag;\n    }\n',
      '    pub fn set_autoplay(&mut self, flag: bool) {\n        self.chart_renderer.autoplay = flag;\n    }\n\n    /// Preview patch: 0.0 silences the mix, 1.0 keeps the original level.\n    pub fn set_volume(&mut self, volume: f32) {\n        self.audio_engine.set_volume(volume);\n    }\n',
    ],
  ]);
  patchFile('monitor-client/src/engine/note.rs', [
    [
      '        let mut draw_part = |y: f32, h: f32, r: Rect| {\n            if h <= 0.0001 {\n                return;\n            }\n            let mut draw_y = y;\n            let mut draw_h = h;\n            let mut draw_v = r.y;\n            let mut draw_vs = r.h;\n\n            // Clip bottom only if config.draw_below is false\n            if !config.draw_below && draw_y < 0.0 {\n',
      '        // The hold head is exempt from the below-line clip. Its quad sits entirely below\n        // the head position, so for charts whose lines hide what is below them (isCover)\n        // the cap was clipped away the moment it reached the line and stayed invisible for\n        // the whole hold. prpr keeps it when the pack sets holdKeepHead; this port dropped\n        // that flag, and dropping the head was never intended.\n        let mut draw_part = |y: f32, h: f32, r: Rect, keep_below: bool| {\n            if h <= 0.0001 {\n                return;\n            }\n            let mut draw_y = y;\n            let mut draw_h = h;\n            let mut draw_v = r.y;\n            let mut draw_vs = r.h;\n\n            // Clip bottom only if config.draw_below is false\n            if !keep_below && !config.draw_below && draw_y < 0.0 {\n',
    ],
    [
      '        draw_part(draw_head_y, head_h, head_rect);\n        // Ensure body has positive height\n        if body_h > 0.01 {\n            draw_part(body_y, body_h, body_rect);\n        }\n        draw_part(draw_tail_y, tail_h, tail_rect);\n',
      '        draw_part(draw_head_y, head_h, head_rect, true);\n        // Ensure body has positive height\n        if body_h > 0.01 {\n            draw_part(body_y, body_h, body_rect, false);\n        }\n        draw_part(draw_tail_y, tail_h, tail_rect, false);\n',
    ],
  ]);
  console.log('patched upstream renderer sources: volume control, transparent clear, kept hold head');
}

function main() {
  for (const tool of ['git', 'cargo', 'rustc']) {
    if (!which(tool)) throw new Error(`${tool} not found in PATH`);
  }

  // 1. Clone or update the upstream sources.
  if (fs.existsSync(path.join(rendererSrc, 'monitor-client'))) {
    console.log(`renderer sources present: ${rendererSrc}`);
  } else {
    fs.mkdirSync(path.dirname(rendererSrc), { recursive: true });
    run('git', ['clone', '--depth', '1', upstream, rendererSrc]);
  }
  if (flags.has('--clone-only')) return;

  // 2. Copy the chart compiler next to the sources. It deliberately declares its own
  //    empty [workspace] so cargo resolves only its dependency graph: building from the
  //    upstream workspace root would also select monitor-proxy, whose phira-mp-common
  //    enables the `stream` feature (std::os::unix only) and therefore fails on Windows.
  const compilerDir = path.join(rendererSrc, 'chart-compiler');
  // Only the sources are refreshed; target/ is left alone so repeat builds stay
  // incremental and a --skip-cli run cannot discard a previously built binary.
  fs.mkdirSync(path.join(compilerDir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(compilerSrc, 'src', 'main.rs'), path.join(compilerDir, 'src', 'main.rs'));
  fs.copyFileSync(path.join(compilerSrc, 'Cargo.toml.template'), path.join(compilerDir, 'Cargo.toml'));

  // 2b. Reuse the upstream parser verbatim instead of reimplementing chart formats.
  //     Rust resolves a module's children by the layout of its own directory, so
  //     parse.rs must be copied together with its parse/ sibling directory; a bare
  //     #[path] include of parse.rs would look for extra.rs next to main.rs and fail.
  //     Nothing is edited here: the files are byte-identical to the pinned checkout,
  //     so the compiler and the browser renderer always parse charts the same way.
  const parseSrc = path.join(rendererSrc, 'monitor-proxy', 'src', 'utils');
  fs.copyFileSync(path.join(parseSrc, 'parse.rs'), path.join(compilerDir, 'src', 'parse.rs'));
  copyDir(path.join(parseSrc, 'parse'), path.join(compilerDir, 'src', 'parse'));

  // 3. Build the WASM renderer (ChartPlayer / GameMonitor).
  if (!flags.has('--skip-wasm')) {
    patchUpstream();
    const wasmPack = which('wasm-pack');
    if (!wasmPack) {
      const local = path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin', 'wasm-pack.exe');
      if (!fs.existsSync(local)) {
        throw new Error('wasm-pack not found. Install it, e.g.: cargo install wasm-pack');
      }
      console.log(`using local wasm-pack: ${local}`);
      run(local, ['build', '--target', 'web', '--out-dir', '../web/pkg', '--release'], { cwd: path.join(rendererSrc, 'monitor-client') });
    } else {
      run(wasmPack, ['build', '--target', 'web', '--out-dir', '../web/pkg', '--release'], { cwd: path.join(rendererSrc, 'monitor-client') });
    }
  }

  // 4. Build the native chart compiler (standalone crate, own workspace).
  if (!flags.has('--skip-cli')) {
    run('cargo', ['build', '--release', '--manifest-path', path.join(compilerDir, 'Cargo.toml')]);
  }

  // 5. Publish artifacts into this repository.
  fs.mkdirSync(vendorRoot, { recursive: true });
  const pkgSrc = path.join(rendererSrc, 'web', 'pkg');
  if (fs.existsSync(pkgSrc)) {
    copyDir(pkgSrc, path.join(vendorRoot, 'pkg'));
    console.log(`copied wasm renderer -> vendor/renderer/pkg`);
  }
  const exeName = process.platform === 'win32' ? 'chart-compiler.exe' : 'chart-compiler';
  // The compiler crate is its own workspace root, so cargo writes into its own target dir.
  const exeSrc = [
    path.join(compilerDir, 'target', 'release', exeName),
    path.join(rendererSrc, 'target', 'release', exeName),
  ].find((candidate) => fs.existsSync(candidate));
  if (exeSrc) {
    fs.mkdirSync(path.join(vendorRoot, 'bin'), { recursive: true });
    fs.copyFileSync(exeSrc, path.join(vendorRoot, 'bin', exeName));
    console.log(`copied chart compiler -> vendor/renderer/bin/${exeName}`);
  } else if (!flags.has('--skip-cli')) {
    throw new Error(`chart compiler binary not found after build (looked in ${path.join(compilerDir, 'target', 'release')})`);
  }
  // The upstream default resource pack ("nomo" by 星鹿ELEC & 不会读谱的FW小赵呀) is
  // third-party artwork with no license grant, so it is never vendored automatically.
  // Without it the renderer falls back to its built-in solid-colour textures; pass
  // --respack to copy it into a local, git-ignored checkout for personal use.
  const respackSrc = path.join(rendererSrc, 'web', 'public', 'assets', 'respack', 'default');
  if (flags.has('--respack') && fs.existsSync(respackSrc)) {
    copyDir(respackSrc, path.join(vendorRoot, 'respack'));
    console.log('copied respack -> vendor/renderer/respack (third-party artwork, local use only)');
  }
  for (const dir of ['pkg', 'bin', 'respack']) {
    const target = path.join(vendorRoot, dir);
    if (!fs.existsSync(target)) continue;
    const files = fs.readdirSync(target);
    const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(target, f)).size, 0);
    console.log(`  ${dir.padEnd(8)} ${String(files.length).padStart(3)} files  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log('\nrenderer build complete.');
}

try {
  main();
} catch (error) {
  console.error(`\nbuild-renderer failed: ${error.message}`);
  process.exitCode = 1;
}
