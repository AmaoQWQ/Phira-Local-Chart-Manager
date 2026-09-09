import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export interface DecodeOptions {
  /** 26-byte verification key recovered from the supplied v0.8.2 build. */
  key: Buffer;
  expectedChartId?: number;
  /** Obtain from authenticated session, not from the request body. */
  expectedUserId?: number;
}

/** Read-only v3 parser. valid does not assert official server acceptance. */
export function decodePhiraRecordToken(token: string, options: DecodeOptions) {
  let stage = 'envelope';
  let integrityVerified = false;
  try {
    if (typeof token !== 'string' || token.length === 0 || token.length > 2097152 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(token)) {
      throw new Error('Invalid or oversized standard Base64');
    }
    const raw = Buffer.from(token, 'base64');
    if (raw.toString('base64') !== token) throw new Error('Noncanonical Base64');
    const inflated = inflateRawSync(raw, { maxOutputLength: 1048576, info: true }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    if (inflated.engine.bytesWritten !== raw.length) throw new Error('Trailing DEFLATE data');
    const payload = inflated.buffer;
    if (payload.length < 48 || (payload.length - 32) % 16 !== 0) {
      throw new Error('Invalid protected payload length');
    }
    stage = 'verify';
    if (!Buffer.isBuffer(options.key) || options.key.length !== 26) {
      throw new Error('v0.8.2 verification key must be 26 bytes');
    }
    const protectedData = payload.subarray(0, -32);
    const tag = payload.subarray(-32);
    const expected = createHmac('sha256', options.key).update(protectedData).digest();
    if (!timingSafeEqual(expected, tag)) throw new Error('HMAC-SHA256 mismatch');
    integrityVerified = true;
    stage = 'parse';
    const plainPadded = Buffer.alloc(protectedData.length);
    const permutation = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let start = 0; start < protectedData.length; start += 16) {
      const block = Buffer.from(permutation.map(i => protectedData[start + i]));
      for (const stride of [8, 4, 2, 1]) {
        for (let i = 0; i < 16; i++) {
          if (i & stride) block[i] = (block[i] - block[i - stride]) & 255;
        }
      }
      block.copy(plainPadded, start);
    }
    const remainder = plainPadded[plainPadded.length - 1];
    const padding = 16 - remainder;
    if (remainder > 15 || !plainPadded.subarray(-padding).every(b => b === remainder)) {
      throw new Error('Invalid remainder padding');
    }
    const p = plainPadded.subarray(0, -padding);
    if (p.length !== 92 || p[0] !== 3) throw new Error('Unsupported record schema');
    const userId = p.readInt32LE(1);
    const chartId = p.readInt32BE(5);
    const statisticF64At9 = p.readDoubleLE(9);
    const maxCombo = p.readUInt32LE(29);
    const [perfect, good, bad, miss] = [33, 37, 41, 45].map(off => p.readUInt32LE(off));
    const numOfNotes = p.readUInt32LE(84);
    if (!numOfNotes || maxCombo > numOfNotes || perfect + good > numOfNotes ||
        !Number.isFinite(statisticF64At9)) throw new Error('Invalid record numeric fields');
    const accuracy = (perfect + good * 0.65) / numOfNotes;
    const score = perfect === numOfNotes ? 1000000 :
      Math.floor((0.9 * accuracy + 0.1 * maxCombo / numOfNotes) * 1000000 + 0.5);
    stage = 'binding';
    if (options.expectedChartId !== undefined && chartId !== options.expectedChartId) {
      throw new Error('Inner chart ID differs from expected chart ID');
    }
    if (options.expectedUserId !== undefined && userId !== options.expectedUserId) {
      throw new Error('Inner user ID differs from authenticated user ID');
    }
    return { valid: true as const, verification: {
      mac: 'HMAC-SHA256', integrityVerified: true,
      chartBound: options.expectedChartId !== undefined,
      userBound: options.expectedUserId !== undefined,
      runtimeChecks: 'notEvaluated', officialAcceptance: 'unknown',
    }, record: { userId, chartId, score, accuracy, fullCombo: maxCombo === numOfNotes,
      perfect, good, bad, miss, maxCombo, numOfNotes },
    extra: { version: 3, statisticF64At9, modsRaw: p.readUInt32LE(17),
      runtimeFlagBytes: [...p.subarray(21, 24)], runtimeWordAt24: p.readUInt32LE(24),
      runtimeMarkerAt28: p[28], speedPercent: p[49],
      chartDigestSha256Candidate: p.subarray(50, 82).toString('hex'),
      runtimeMarkersAt82: [...p.subarray(82, 84)], modsCopyRaw: p.readUInt32LE(88) },
    payloadSha256: createHash('sha256').update(payload).digest('hex') };
  } catch (error) {
    return { valid: false as const, stage, integrityVerified,
      error: error instanceof Error ? error.message : 'Decode failure' };
  }
}
