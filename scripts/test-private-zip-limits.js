const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deflateRawSync } = require("node:zlib");
const {
  PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES,
  PRIVATE_CHART_ZIP_MAX_TOTAL_BYTES,
  PrivateChartStore,
  ZipSizeLimitError,
} = require("../dist/private-chart.js");

const MiB = 1024 * 1024;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phira-private-zip-"));

function zip(items) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, "utf8");
    const compressed = item.store ? item.data : deflateRawSync(item.data);
    const declaredSize = item.declaredSize === undefined ? item.data.length : item.declaredSize;
    const method = item.store ? 0 : 8;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(Buffer.concat([local, compressed]));

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, end]);
}

function zeroEntry(name, size, extras = {}) {
  return { name, data: Buffer.alloc(size), ...extras };
}

function expectSizeLimit(action, description) {
  assert.throws(action, (error) => error instanceof ZipSizeLimitError, description);
}

function assertNoChart(store, id) {
  assert.equal(store.get(id), null, `chart ${id} was added`);
  assert.equal(fs.existsSync(store.directoryFor(id)), false, `chart ${id} files were written`);
}

function releaseBuffers() {
  if (global.gc) global.gc();
}

try {
  const store = new PrivateChartStore(path.join(tempRoot, "charts"));
  let packageFile = zip([zeroEntry("data.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES)]);
  store.create({ id: -101 }, { packageFile });
  assert.ok(store.get(-101), "a ZIP entry exactly at the per-entry limit should be accepted");
  packageFile = null;
  releaseBuffers();

  packageFile = zip([zeroEntry("data.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES + 1)]);
  expectSizeLimit(() => store.create({ id: -102 }, { packageFile }), "one byte over the per-entry limit should fail");
  assertNoChart(store, -102);
  packageFile = null;
  releaseBuffers();

  packageFile = zip(Array.from({ length: 1025 }, (_, index) => ({ name: `entry-${index}.bin`, data: Buffer.alloc(0) })));
  expectSizeLimit(() => store.create({ id: -107 }, { packageFile }), "more than 1024 entries should fail");
  assertNoChart(store, -107);
  packageFile = null;
  releaseBuffers();

  packageFile = zip([
    zeroEntry("first.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES),
    zeroEntry("second.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES),
  ]);
  store.create({ id: -103 }, { packageFile });
  assert.ok(store.get(-103), "a ZIP whose declared and actual total exactly reaches the limit should be accepted");
  packageFile = null;
  releaseBuffers();

  packageFile = zip([
    zeroEntry("first.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES),
    zeroEntry("second.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES),
    zeroEntry("third.bin", 1),
  ]);
  expectSizeLimit(() => store.create({ id: -104 }, { packageFile }), "one byte over the total limit should fail");
  assertNoChart(store, -104);
  packageFile = null;
  releaseBuffers();

  packageFile = zip([zeroEntry("forged.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES + 1, { declaredSize: 1 })]);
  expectSizeLimit(() => store.create({ id: -105 }, { packageFile }), "a falsely small declared size must not bypass the inflate output cap");
  assertNoChart(store, -105);
  packageFile = null;
  releaseBuffers();

  packageFile = zip([zeroEntry("stored.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES + 1, { store: true })]);
  expectSizeLimit(() => store.create({ id: -106 }, { packageFile }), "stored entries must obey the per-entry limit");
  assertNoChart(store, -106);
  packageFile = null;
  releaseBuffers();

  const childOne = zip([zeroEntry("first.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES)]);
  const childTwo = zip([zeroEntry("second.bin", PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES)]);
  const collection = zip([
    { name: "#-201_first.pez", data: childOne },
    { name: "#-202_second.pez", data: childTwo },
  ]);
  expectSizeLimit(() => store.importCollection(collection), "nested packages must share the collection upload budget");
  assertNoChart(store, -201);
  assertNoChart(store, -202);
  releaseBuffers();

  const music = Buffer.from("music-bytes");
  const regularPackage = zip([
    { name: "info.txt", data: Buffer.from("name: Normal\nlevel: IN 12\nmusic: music.mp3\n") },
    { name: "music.mp3", data: music },
  ]);
  const normal = store.create({ id: -301 }, { packageFile: regularPackage });
  assert.equal(normal.name, "Normal");
  assert.equal(fs.readFileSync(path.join(store.directoryFor(-301), "music.mp3")).toString(), "music-bytes");
  assert.ok(fs.readFileSync(path.join(store.directoryFor(-301), "chart-package.pez")).length > regularPackage.length, "legacy info.txt normalization should still run");

  const collectionPackage = zip([
    { name: "#-302_one.pez", data: regularPackage },
    { name: "#-303_two.pez", data: regularPackage },
  ]);
  const imported = store.importCollection(collectionPackage);
  assert.equal(imported.created.length, 2, "a normal collection should import every child");
  assert.equal(imported.skipped.length, 0);

  fs.rmSync(path.join(store.directoryFor(-301), "music.mp3"));
  new PrivateChartStore(path.join(tempRoot, "charts"));
  assert.equal(fs.readFileSync(path.join(store.directoryFor(-301), "music.mp3")).toString(), "music-bytes", "startup repair should restore an extracted asset");

  const legacy = store.create({ id: -304 }, { packageFile: Buffer.from("legacy non-ZIP package") });
  assert.ok(legacy);
  assert.equal(fs.readFileSync(path.join(store.directoryFor(-304), "chart-package.pez")).toString(), "legacy non-ZIP package");

  assert.ok(PRIVATE_CHART_ZIP_MAX_TOTAL_BYTES > PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES);
  console.log("Private ZIP limit test passed: boundary sizes, forged declarations, stored entries, collection budget/atomicity, normal packages, startup repair, and non-ZIP compatibility.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
