import crypto from "node:crypto";
import https from "node:https";

/** Resolve the Phira account, independently of panel sessions and local score bindings. */
export class PhiraViewerResolver {
  private cache = new Map<string, { id: number | null; until: number }>();
  private pending = new Map<string, Promise<number | null>>();
  constructor(private readonly upstreamBaseUrl: string) {}

  async resolve(authorization: string | string[] | undefined): Promise<number | null> {
    if (typeof authorization !== "string" || authorization.length > 8192 || !/^Bearer\s+\S+$/i.test(authorization)) return null;
    const key = crypto.createHash("sha256").update(authorization).digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.id;
    const running = this.pending.get(key);
    if (running) return running;
    if (this.pending.size >= 32) return null;
    const operation = this.lookup(authorization).catch(() => null).then(id => {
      for (const [key, entry] of this.cache) if (entry.until <= Date.now()) this.cache.delete(key);
      if (this.cache.size >= 2000) this.cache.delete(this.cache.keys().next().value!);
      // Persist neither Authorization nor the full official profile; cache keys are hashes.
      this.cache.set(key, { id, until: Date.now() + (id === null ? 10000 : 60000) });
      return id;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private lookup(authorization: string): Promise<number | null> {
    return new Promise(resolve => {
      const target = new URL("/me", this.upstreamBaseUrl);
      if (target.protocol !== "https:") { resolve(null); return; }
      let finished = false;
      const finish = (id: number | null) => { if (!finished) { finished = true; clearTimeout(timer); resolve(id); } };
      const timer = setTimeout(() => { finish(null); request.destroy(); }, 3000);
      const request = https.get(target, { headers: { authorization, accept: "application/json" } }, response => {
        if (response.statusCode !== 200) { finish(null); response.destroy(); return; }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) { finish(null); response.destroy(); return; }
          chunks.push(chunk);
        });
        response.on("error", () => finish(null));
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown };
            finish(typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 && value.id <= 2147483647 ? value.id : null);
          } catch { finish(null); }
        });
      });
      request.on("error", () => finish(null));
    });
  }
}
