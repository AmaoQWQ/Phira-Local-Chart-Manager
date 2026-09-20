//! PEZ → `bincode(ChartInfo, Chart)`（varint）编译器。
//!
//! 供 `monitor-client` 的 `ChartPlayer::load_chart(id)` 使用：它在
//! `GET {api_base}/chart/{id}` 上期望的正是这个二进制负载。
//!
//! 解析层直接复用 phira-web-monitor（MIT）的 `monitor-common` 与
//! `monitor-proxy/src/utils/parse.rs`（构建脚本按原目录布局整体复制过来，
//! 不做任何改动），因此与浏览器渲染器**同源同版本**，不存在"自己猜格式"的偏差。
//!
//! 用法：
//!   chart-compiler <package.pez> <out.bin>      # 编译谱面包
//!   chart-compiler --dir <extracted-dir> <out.bin>
//!   chart-compiler --verify <out.bin>           # 回读校验并打印摘要

mod parse;

use anyhow::{Context, Result};
use bincode::Options;
use monitor_common::core::{Chart, ChartInfo};
use parse::{load_chart, ResourceLoader};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;

/// 与 monitor-proxy 的 DirectoryLoader 同构：只接受普通路径分量，
/// 防止恶意包用 `..` 逃出解压目录。
struct DirectoryLoader {
    directory: PathBuf,
}

impl ResourceLoader for DirectoryLoader {
    fn load_file<'a>(
        &'a mut self,
        path: &'a str,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<u8>>> + Send + 'a>> {
        let mut safe = PathBuf::new();
        for component in Path::new(path).components() {
            match component {
                Component::Normal(name) => safe.push(name),
                Component::ParentDir => {
                    safe.pop();
                }
                _ => {}
            }
        }
        let full = self.directory.join(safe);
        let label = full.display().to_string();
        Box::pin(async move {
            tokio::fs::read(&full)
                .await
                .with_context(|| format!("cannot read {label}"))
        })
    }
}

fn usage() -> ! {
    eprintln!("usage: chart-compiler <package.pez> <out.bin>");
    eprintln!("       chart-compiler --dir <extracted-dir> <out.bin>");
    eprintln!("       chart-compiler --verify <out.bin>");
    std::process::exit(2)
}

/// Image formats a browser displays directly; anything else is left alone.
const BROWSER_IMAGE_EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "gif", "webp", "avif"];

/// Copies the chart illustration next to the payload so the gateway can serve it as the
/// playfield background. prpr (the reference player) builds its background from exactly
/// this file, so the preview needs it too. Returns the extension that was written.
fn copy_illustration(directory: &Path, illustration: &str, output: &Path) -> Option<String> {
    let extension = Path::new(illustration)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    if !BROWSER_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    // Same sanitising as the loader: a package must not escape its directory.
    let mut safe = PathBuf::new();
    for component in Path::new(illustration).components() {
        if let Component::Normal(name) = component {
            safe.push(name);
        }
    }
    let data = std::fs::read(directory.join(safe)).ok()?;
    let target = output.with_extension(format!("bg.{extension}"));
    std::fs::write(&target, data).ok()?;
    Some(extension)
}

fn summarize(
    info: &ChartInfo,
    chart: &Chart,
    bytes: usize,
    background: Option<&str>,
) -> serde_json::Value {
    let mut notes = 0usize;
    let mut last_note = 0f32;
    let mut chart_end = 0f32;
    for line in &chart.lines {
        notes += line.notes.len();
        for note in &line.notes {
            last_note = last_note.max(note.time);
            // `end_time` is the hold tail for long notes and the note time otherwise.
            chart_end = chart_end.max(note.end_time());
        }
    }
    let (samples, sample_rate, channels) = match &chart.music {
        Some(music) => (music.samples.len(), music.sample_rate, music.channel_count),
        None => (0, 0, 0),
    };
    // Samples are interleaved, so the frame count is samples / channels.
    let music_seconds = if channels > 0 && sample_rate > 0 {
        samples as f32 / channels as f32 / sample_rate as f32
    } else {
        0.0
    };
    // The preview must run until both the chart content and the music are over. Using the
    // last note's start time cut a trailing hold short, and ignoring the music ignored a
    // longer outro, so both bounds are taken.
    let duration = chart_end.max(music_seconds);
    serde_json::json!({
        "ok": true,
        "name": info.name,
        "lines": chart.lines.len(),
        "notes": notes,
        "lastNote": last_note,
        "chartEnd": chart_end,
        "musicSeconds": music_seconds,
        "duration": duration,
        "offset": chart.offset,
        "musicSamples": samples,
        "sampleRate": sample_rate,
        "channels": channels,
        "bytes": bytes,
        // Background handling, mirroring the reference player: the illustration is drawn
        // full-screen (cover) behind the playfield and dimmed by `backgroundDim`.
        "illustration": info.illustration,
        "backgroundDim": info.background_dim,
        "backgroundExtension": background.unwrap_or(""),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        usage();
    }

    if args[0] == "--verify" {
        let bytes = std::fs::read(args.get(1).context("missing <out.bin>")?)
            .context("cannot read compiled payload")?;
        let (info, chart): (ChartInfo, Chart) = bincode::options()
            .with_varint_encoding()
            .deserialize(&bytes)
            .context("payload is not a valid (ChartInfo, Chart) bincode")?;
        println!(
            "{}",
            summarize(&info, &chart, bytes.len(), None)
        );
        return Ok(());
    }

    // 谱面包 → 临时目录（或直接用已解压目录）
    let (directory, _guard, out) = if args[0] == "--dir" {
        if args.len() < 3 {
            usage();
        }
        (
            PathBuf::from(&args[1]),
            None,
            PathBuf::from(&args[2]),
        )
    } else {
        if args.len() < 2 {
            usage();
        }
        let pez = PathBuf::from(&args[0]);
        let out = PathBuf::from(&args[1]);
        if !pez.is_file() {
            anyhow::bail!("package not found: {}", pez.display());
        }
        let guard = tempfile::tempdir().context("cannot create temp dir")?;
        let file = std::fs::File::open(&pez).context("cannot open package")?;
        let mut archive = zip::ZipArchive::new(file).context("package is not a readable zip")?;
        archive
            .extract(guard.path())
            .context("cannot extract package")?;
        (guard.path().to_path_buf(), Some(guard), out)
    };

    let mut loader = DirectoryLoader {
        directory: directory.clone(),
    };
    let (info, chart) = load_chart(&mut loader)
        .await
        .with_context(|| format!("failed to parse chart package at {}", directory.display()))?;

    let bytes = bincode::options()
        .with_varint_encoding()
        .serialize(&(&info, &chart))
        .context("failed to serialize chart")?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&out, &bytes).with_context(|| format!("cannot write {}", out.display()))?;
    // Written next to the payload, so the gateway can serve the playfield background.
    let background = copy_illustration(&directory, &info.illustration, &out);

    println!(
        "{}",
        summarize(&info, &chart, bytes.len(), background.as_deref())
    );
    Ok(())
}
