import { decodePhiraRecordToken } from './phira-record-decoder';

type Success = Extract<ReturnType<typeof decodePhiraRecordToken>, { valid: true }>;
export interface UploadResponse {
  id: number; expDelta: number; newBest: boolean; improvement: number; newRks: number;
}
export interface PrivateUploadDependencies<T> {
  verificationKey: Buffer;
  isRegisteredPrivateChart(chartId: number): Promise<boolean>;
  /** Must forward the original request, including its original body bytes. */
  forwardOriginal(): Promise<T>;
  authenticatedUserId(): Promise<number>;
  /** Transactionally store/deduplicate by userId/chartId/payloadSha256.
   * Return locally computed response fields and a private record ID.
   * Decide private runtime-field policy here; MAC validity alone is not that policy.
   */
  storePrivateRecord(decoded: Success, chartUpdated: string | null | undefined): Promise<UploadResponse>;
  reply(status: number, body: unknown): Promise<T>;
}

/** Framework-neutral integration seam; invoke only for POST /play/upload. */
export async function handlePrivateUpload<T>(body: unknown, deps: PrivateUploadDependencies<T>): Promise<T> {
  if (!body || typeof body !== 'object') return deps.forwardOriginal();
  const input = body as Record<string, unknown>;
  if (typeof input.chart !== 'number' || !Number.isInteger(input.chart) ||
      input.chart < -2147483648 || input.chart > 2147483647 ||
      !await deps.isRegisteredPrivateChart(input.chart)) return deps.forwardOriginal();
  if (typeof input.token !== 'string' ||
      (input.chartUpdated !== undefined && input.chartUpdated !== null && typeof input.chartUpdated !== 'string')) {
    return deps.reply(400, { error: 'Malformed private record upload' });
  }
  const userId = await deps.authenticatedUserId();
  if (!Number.isInteger(userId) || userId <= 0) return deps.reply(401, { error: 'Authentication required' });
  const decoded = decodePhiraRecordToken(input.token, {
    key: deps.verificationKey, expectedChartId: input.chart, expectedUserId: userId,
  });
  if (!decoded.valid) return deps.reply(400, { error: decoded.error, stage: decoded.stage });
  const response = await deps.storePrivateRecord(decoded, input.chartUpdated as string | null | undefined);
  return deps.reply(200, response);
}
