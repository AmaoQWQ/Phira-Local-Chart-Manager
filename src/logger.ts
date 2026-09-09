import fs from "node:fs";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { redactHeaders } from "./redact";

export interface RequestLog {
  timestamp: string;
  remoteIp: string;
  method: string;
  host: string;
  path: string;
  query: string;
  contentType: string;
  bodySize: number;
  userAgent: string;
  httpVersion: string;
  headers: IncomingHttpHeaders;
  bodyPreview?: string;
}

export class RequestLogger {
  public constructor(
    private readonly logToFile: boolean,
    private readonly logFilePath: string,
  ) {}

  public write(entry: RequestLog): void {
    const safeHeaders = redactHeaders(entry.headers);
    const lines = [
      `[${entry.timestamp}]`,
      `${entry.method} ${entry.path}${entry.query}`,
      `Host: ${entry.host}`,
      `Remote: ${entry.remoteIp}`,
      `HTTP: ${entry.httpVersion}`,
      `User-Agent: ${entry.userAgent}`,
      `Content-Type: ${entry.contentType}`,
      `Body: ${entry.bodySize} bytes`,
      `Headers: ${JSON.stringify(safeHeaders)}`,
    ];

    if (entry.bodyPreview !== undefined) {
      lines.push(`Body-Preview: ${entry.bodyPreview}`);
    }

    const output = `${lines.join("\n")}\n\n`;
    process.stdout.write(output);

    if (this.logToFile) {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      fs.appendFileSync(this.logFilePath, output, "utf8");
    }
  }
}
