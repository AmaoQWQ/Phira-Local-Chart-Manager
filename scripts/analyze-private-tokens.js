const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { gunzipSync, inflateSync, brotliDecompressSync } = require("node:zlib");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run analyze:private-tokens -- data/private-records/token-capture.jsonl");
  process.exit(1);
}

const resolvedPath = path.resolve(process.cwd(), inputPath);
const lines = fs.readFileSync(resolvedPath, "utf8").split(/\r?\n/).filter(Boolean);
const samples = lines.map((line, index) => {
  let value;
  try { value = JSON.parse(line); } catch { throw new Error(`invalid JSON at line ${index + 1}`); }
  if (!value || typeof value.token !== "string") throw new Error(`missing token at line ${index + 1}`);
  const normalized = value.token.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(normalized, "base64");
  return { index: index + 1, capturedAt: value.capturedAt, tokenChars: value.token.length, decoded };
});

function printableRatio(buffer) {
  if (!buffer.length) return 0;
  let printable = 0;
  for (const byte of buffer) if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable++;
  return printable / buffer.length;
}

function decodeCandidates(buffer) {
  const candidates = [{ name: "raw", buffer }];
  for (const [name, decoder] of [["gzip", gunzipSync], ["zlib", inflateSync], ["brotli", brotliDecompressSync]]) {
    try { candidates.push({ name, buffer: decoder(buffer) }); } catch { /* not this format */ }
  }
  return candidates;
}

function changedPositions(left, right) {
  const changed = [];
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) if (left[i] !== right[i]) changed.push(i);
  return changed;
}

console.log(`samples=${samples.length}`);
for (const sample of samples) {
  const sha256 = crypto.createHash("sha256").update(sample.decoded).digest("hex");
  const prefix = sample.decoded.subarray(0, 32).toString("hex");
  console.log(JSON.stringify({
    line: sample.index,
    capturedAt: sample.capturedAt,
    tokenChars: sample.tokenChars,
    decodedBytes: sample.decoded.length,
    decodedSha256: sha256,
    prefixHex: prefix,
    printableRatio: Number(printableRatio(sample.decoded).toFixed(3)),
    candidates: decodeCandidates(sample.decoded).map((candidate) => ({
      format: candidate.name,
      bytes: candidate.buffer.length,
      printableRatio: Number(printableRatio(candidate.buffer).toFixed(3)),
      startsLikeJson: /^\s*[\[{]/.test(candidate.buffer.toString("utf8")),
    })),
  }));
}

if (samples.length > 1) {
  const changed = changedPositions(samples[0].decoded, samples[1].decoded);
  console.log(JSON.stringify({
    comparison: `${samples[0].index}->${samples[1].index}`,
    changedByteCount: changed.length,
    changedBytePositions: changed.slice(0, 128),
    positionsTruncated: changed.length > 128,
  }));
}

console.log("No token values were printed.");
