export interface ManagedChart {
  id: number;
  name: string;
}

export interface ManagedRoom {
  ok: true;
  hosted: boolean;
  roomid: string;
  owner_id: number | null;
  capacity: number;
  allowed_user_ids: number[];
  host_id: number | null;
  chart: ManagedChart | null;
  chart_mode: "HOST_SELECT" | "POOL_RANDOM";
  chart_pool: ManagedChart[];
  state?: string;
  users?: number[];
  monitors?: number[];
  created?: boolean;
}

export class PmpAdminError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly code = "pmp-admin-error",
  ) {
    super(message);
  }
}

/** Server-side PMP+ admin client. The browser never receives the PMP token. */
export class PmpAdminClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl && this.token.trim());
  }

  async request(pathname: string, method = "GET", body?: unknown): Promise<unknown> {
    if (!this.enabled) throw new PmpAdminError("PMP+ 房间管理尚未配置", 503, "pmp-admin-disabled");
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.baseUrl), {
        method,
        signal: AbortSignal.timeout(5_000),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-admin-token": this.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PmpAdminError(`无法连接 PMP+ 房间管理接口：${message}`, 502, "pmp-unreachable");
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error === "string" ? payload.error : `PMP+ 返回 HTTP ${response.status}`;
      throw new PmpAdminError(message, response.status, typeof payload?.error === "string" ? payload.error : "pmp-rejected");
    }
    return payload;
  }

  async list(): Promise<{ ok: true; total_rooms: number; rooms: ManagedRoom[] }> {
    return await this.request("/admin/rooms") as { ok: true; total_rooms: number; rooms: ManagedRoom[] };
  }
}
