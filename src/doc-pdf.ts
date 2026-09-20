const FENCE = "```";

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] || char);
}

function inlineMarkdown(value: string): string {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
    `<a href="${url}"${/^https?:\/\//i.test(url) ? " target=\"_blank\" rel=\"noopener\"" : ""}>${label}</a>`);
  return text;
}

function tableRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => inlineMarkdown(cell.trim()));
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

export function renderMarkdownHtml(source: string): string {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const trim = lines[index].trim();
    if (!trim) {
      index += 1;
      continue;
    }

    if (trim.startsWith(FENCE)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(FENCE)) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (
      lines[index].includes("|") &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1])
    ) {
      const rows = [tableRow(lines[index])];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(tableRow(lines[index]));
        index += 1;
      }
      const [head, ...body] = rows;
      output.push(
        "<table><thead><tr>" +
          head.map((cell) => `<th>${cell}</th>`).join("") +
          "</tr></thead><tbody>" +
          body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trim);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1(?:\s*\1)*\s*$/.test(trim)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (trim.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index].trim().startsWith(">") || !lines[index].trim())) {
        if (lines[index].trim().startsWith(">")) quote.push(lines[index].replace(/^\s*>\s?/, ""));
        else quote.push("");
        index += 1;
      }
      output.push(`<blockquote>${renderMarkdownHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(trim);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(trim);
    if (bullet || ordered) {
      output.push(ordered ? "<ol>" : "<ul>");
      while (index < lines.length) {
        const itemBullet = /^\s*[-*+]\s+(.*)$/.exec(lines[index].trim());
        const itemNumber = /^\s*\d+\.\s+(.*)$/.exec(lines[index].trim());
        const isSameType = ordered ? Boolean(itemNumber) : Boolean(itemBullet);
        if (!isSameType) break;
        let content = ordered ? itemNumber![1] : itemBullet![1];
        index += 1;
        while (
          index < lines.length &&
          lines[index].trim() &&
          !/^(#{1,6})\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>\s?/.test(lines[index]) &&
          !lines[index].trim().startsWith(FENCE)
        ) {
          content += ` ${lines[index].trim()}`;
          index += 1;
        }
        output.push(`<li>${inlineMarkdown(content)}</li>`);
      }
      output.push(ordered ? "</ol>" : "</ul>");
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s*>\s?/.test(lines[index]) &&
      !lines[index].trim().startsWith(FENCE) &&
      !(lines[index].includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    output.push(`<p>${paragraph.map((line) => inlineMarkdown(line)).join("<br>")}</p>`);
  }

  return output.join("\n");
}

export function documentPdfHtml(options: { title: string; source: string }): string {
  const { title, source } = options;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} · Phira 本地谱面管理系统</title>
<style>
@page{size:A4;margin:15mm 13mm}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:Inter,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;color:#1b2627;font-size:10.5pt;line-height:1.7;background:#fff}
h1,h2,h3,h4{line-height:1.35;margin:20px 0 8px;color:#0f1c1d;page-break-after:avoid}
h1{font-size:20pt;font-weight:700;border-bottom:2px solid #d5e9df;padding-bottom:6px}
h2{font-size:14pt;border-bottom:1px solid #dce6e3;padding-bottom:4px}
h3{font-size:11.5pt}
h4{font-size:10.5pt}
p{margin:7px 0}
ul,ol{margin:7px 0;padding-left:20px}
li{margin:3px 0}
a{color:#17694f;word-break:break-all}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:8.5pt;table-layout:fixed}
th,td{border:1px solid #c4d3cf;padding:4px 6px;text-align:left;vertical-align:top;word-break:break-word}
th{background:#eef5f1;color:#123c2d;font-weight:600}
tr{page-break-inside:avoid}
pre{background:#f3f6f5;border:1px solid #d6e0dd;border-radius:4px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;font:8pt Consolas,Menlo,monospace;line-height:1.5;page-break-inside:avoid}
code{font-family:Consolas,Menlo,monospace;background:#eef3f1;border-radius:3px;padding:0 3px;font-size:90%}
pre code{background:transparent;padding:0}
blockquote{margin:10px 0;padding:6px 12px;border-left:3px solid #79c2a4;background:#f4faf7;color:#2b3a36}
blockquote p{margin:3px 0}
hr{border:0;border-top:1px solid #d6e0dd;margin:16px 0}
img{max-width:100%}
.doc-cover{margin-bottom:18px;padding-bottom:10px;border-bottom:2px solid #bfe3d2}
.doc-cover small{display:block;color:#4c6a61;font-size:9pt;letter-spacing:2px;text-transform:uppercase}
.doc-cover h1{margin:4px 0 2px;border:0;padding:0}
.doc-cover p{margin:4px 0 0;color:#5a6b66}
</style>
</head>
<body>
<div class="doc-cover">
<small>PHIRA LOCAL CHART MANAGER · DOCUMENTATION</small>
<h1>${escapeHtml(title)}</h1>
</div>
${renderMarkdownHtml(source)}
</body>
</html>`;
}
