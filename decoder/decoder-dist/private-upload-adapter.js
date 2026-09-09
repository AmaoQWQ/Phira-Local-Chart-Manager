"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePrivateUpload = handlePrivateUpload;
const phira_record_decoder_1 = require("./phira-record-decoder");
/** Framework-neutral integration seam; invoke only for POST /play/upload. */
async function handlePrivateUpload(body, deps) {
    if (!body || typeof body !== 'object')
        return deps.forwardOriginal();
    const input = body;
    if (typeof input.chart !== 'number' || !Number.isInteger(input.chart) ||
        input.chart < -2147483648 || input.chart > 2147483647 ||
        !await deps.isRegisteredPrivateChart(input.chart))
        return deps.forwardOriginal();
    if (typeof input.token !== 'string' ||
        (input.chartUpdated !== undefined && input.chartUpdated !== null && typeof input.chartUpdated !== 'string')) {
        return deps.reply(400, { error: 'Malformed private record upload' });
    }
    const userId = await deps.authenticatedUserId();
    if (!Number.isInteger(userId) || userId <= 0)
        return deps.reply(401, { error: 'Authentication required' });
    const decoded = (0, phira_record_decoder_1.decodePhiraRecordToken)(input.token, {
        key: deps.verificationKey, expectedChartId: input.chart, expectedUserId: userId,
    });
    if (!decoded.valid)
        return deps.reply(400, { error: decoded.error, stage: decoded.stage });
    const response = await deps.storePrivateRecord(decoded, input.chartUpdated);
    return deps.reply(200, response);
}
