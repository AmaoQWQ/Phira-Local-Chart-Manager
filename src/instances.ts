import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import { PrivateChartStore } from "./private-chart";
import { PrivateRecordSqliteStore } from "./private-record-sqlite";
import { AdminError } from "./admin-accounts";

export interface InstanceVisibility { mode: "all" | "users" | "none"; userIds: number[] }
export function parseInstanceVisibility(input: unknown): InstanceVisibility {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError(422, "可见范围格式不正确");
  const value = input as Record<string, unknown>;
  if (!["all", "users", "none"].includes(String(value.mode))) throw new AdminError(422, "请选择所有人、指定用户或所有人不可见");
  if (value.mode !== "users") return { mode: value.mode as "all" | "none", userIds: [] };
  if (!Array.isArray(value.userIds) || !value.userIds.length || value.userIds.length > 1000 || value.userIds.some(id => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) throw new AdminError(422, "请填写 1–1000 个有效的 Phira UID（正整数）");
  return { mode: "users", userIds: [...new Set(value.userIds as number[])] };
}

export interface ChartServiceInstanceDefinition {
  ownerId?: number | null;
  visibility?: InstanceVisibility;
  id: string;
  name: string;
  hosts: string[];
  enabled: boolean;
  chartsPath: string;
  recordsPath: string;
  recordsDatabasePath: string;
  tokenCapturePath: string | null;
  created: string;
  updated: string;
}

export interface ChartServiceInstanceRuntime {
  definition: ChartServiceInstanceDefinition;
  charts: PrivateChartStore;
  records: PrivateRecordSqliteStore;
}

interface PersistedInstances {
  version: 1;
  instances: ChartServiceInstanceDefinition[];
}

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function normalizeHost(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^https?:\/\//, "").replace(/:\d+$/, "").replace(/\.$/, "");
}

function cleanHosts(values: unknown): string[] {
  const source = Array.isArray(values) ? values : typeof values === "string" ? values.split(",") : [];
  return [...new Set(source.map(String).map(normalizeHost).filter(Boolean))];
}

function isDefinition(value: unknown): value is ChartServiceInstanceDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<ChartServiceInstanceDefinition>;
  return typeof item.id === "string" && INSTANCE_ID_PATTERN.test(item.id)
    && typeof item.name === "string" && Array.isArray(item.hosts)
    && typeof item.enabled === "boolean" && typeof item.chartsPath === "string"
    && typeof item.recordsPath === "string" && typeof item.recordsDatabasePath === "string"
    && (item.tokenCapturePath === null || typeof item.tokenCapturePath === "string")
    && typeof item.created === "string" && typeof item.updated === "string";
}

export class ChartServiceInstanceRegistry {
  private readonly metadataPath: string;
  private data: PersistedInstances;
  private readonly runtimes = new Map<string, ChartServiceInstanceRuntime>();
  private readonly instanceRoot: string;

  constructor(private readonly config: Config) {
    this.instanceRoot = path.dirname(config.instancesPath);
    this.metadataPath = config.instancesPath;
    this.data = this.load();
    this.ensureDefaultInstance();
  }

  list(): ChartServiceInstanceDefinition[] {
    return this.data.instances.map((item) => ({ ...item, hosts: [...item.hosts], ...(item.visibility ? { visibility: { ...item.visibility, userIds: [...item.visibility.userIds] } } : {}) }));
  }

  get(id: string): ChartServiceInstanceDefinition | null {
    return this.data.instances.find((item) => item.id === id) || null;
  }

  runtime(id: string): ChartServiceInstanceRuntime {
    const definition = this.get(id);
    if (!definition) throw new Error("chart service instance not found");
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const runtime: ChartServiceInstanceRuntime = {
      definition,
      charts: new PrivateChartStore(definition.chartsPath, chartId => this.data.instances.every(item => item.id === id || !this.runtime(item.id).charts.get(chartId))),
      records: new PrivateRecordSqliteStore(definition.recordsDatabasePath, definition.recordsPath),
    };
    this.runtimes.set(id, runtime);
    return runtime;
  }

  defaultRuntime(): ChartServiceInstanceRuntime {
    return this.runtime(DEFAULT_INSTANCE_ID);
  }

  resolveForHost(hostHeader: string | undefined): ChartServiceInstanceRuntime {
    const host = normalizeHost(hostHeader || "");
    const found = this.data.instances.find((item) => item.hosts.includes(host));
    return this.runtime(found?.id || DEFAULT_INSTANCE_ID);
  }

  resolveForChart(chartId: number, host: string | undefined): ChartServiceInstanceRuntime {
    const primary = this.resolveForHost(host);
    if (primary.charts.get(chartId)) return primary;
    const owners = this.data.instances.map(i => this.runtime(i.id)).filter(i => i.charts.get(chartId));
    if (owners.length > 1) throw new AdminError(409, "该谱面 ID 在多个实例中重复，请使用原实例入口");
    return owners[0] || primary;
  }

  /**
   * Record detail requests contain only a globally allocated record id. Prefer the
   * host-selected instance, then search the remaining small instance set so PMP can
   * retrieve a score even when it calls the shared API hostname.
   */
  recordById(recordId: number, host: string | undefined): Record<string, unknown> | null {
    const primary = this.resolveForHost(host);
    const ordered = [primary, ...this.data.instances
      .filter(item => item.id !== primary.definition.id)
      .map(item => this.runtime(item.id))];
    for (const runtime of ordered) {
      const record = runtime.records.recordById(recordId);
      if (record) return record;
    }
    return null;
  }

  needsViewer(): boolean { return this.data.instances.some(i => i.enabled && i.visibility?.mode === "users"); }

  visibleCharts(viewer: number | null, host: string | undefined): import("./private-chart").PrivateChartDefinition[] {
    const primaryId = this.resolveForHost(host).definition.id;
    const runtimes = this.data.instances.map(i => this.runtime(i.id));
    const counts = new Map<number, number>();
    for (const runtime of runtimes) for (const chart of runtime.charts.list()) counts.set(chart.id, (counts.get(chart.id) || 0) + 1);
    return runtimes.flatMap(runtime => {
      const def = runtime.definition, visibility = def.visibility;
      // Missing policy keeps old installations scoped to their original Host until edited.
      const visible = !visibility ? def.id === primaryId : visibility.mode === "all" || visibility.mode === "users" && viewer !== null && visibility.userIds.includes(viewer);
      if (!def.enabled || !visible) return [];
      // Old duplicate IDs are retained on disk. Only the original Host may list them;
      // new uploads are globally unique so details, resources and scores stay unambiguous.
      return runtime.charts.list().filter(chart => counts.get(chart.id) === 1 || def.id === primaryId);
    });
  }

  create(input: { id?: unknown; name?: unknown; hosts?: unknown; enabled?: unknown; visibility?: unknown }, ownerId: number | null = null): ChartServiceInstanceDefinition {
    const id = String(input.id ?? "").trim().toLocaleLowerCase();
    if (!INSTANCE_ID_PATTERN.test(id)) throw new Error("instance id must use lowercase letters, numbers, _ or -");
    if (this.get(id)) throw new Error("instance id already exists");
    const now = new Date().toISOString();
    const root = path.join(this.instanceRoot, id);
    const definition: ChartServiceInstanceDefinition = {
      ownerId,
      visibility: input.visibility === undefined ? { mode: "none", userIds: [] } : parseInstanceVisibility(input.visibility),
      id,
      name: String(input.name ?? id).trim() || id,
      hosts: cleanHosts(input.hosts),
      enabled: input.enabled !== false,
      chartsPath: path.join(root, "charts"),
      recordsPath: path.join(root, "records.json"),
      recordsDatabasePath: path.join(root, "records.sqlite"),
      tokenCapturePath: path.join(root, "token-capture.jsonl"),
      created: now,
      updated: now,
    };
    this.data.instances.push(definition);
    this.save();
    return { ...definition, hosts: [...definition.hosts] };
  }

  update(id: string, input: { name?: unknown; hosts?: unknown; enabled?: unknown; visibility?: unknown }): ChartServiceInstanceDefinition | null {
    const definition = this.get(id);
    if (!definition) return null;
    const next: ChartServiceInstanceDefinition = {
      ...definition,
      ...(input.visibility === undefined ? {} : { visibility: parseInstanceVisibility(input.visibility) }),
      name: input.name === undefined ? definition.name : String(input.name).trim() || definition.name,
      hosts: input.hosts === undefined ? definition.hosts : cleanHosts(input.hosts),
      enabled: input.enabled === undefined ? definition.enabled : Boolean(input.enabled),
      updated: new Date().toISOString(),
    };
    const index = this.data.instances.findIndex((item) => item.id === id);
    this.data.instances[index] = next;
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.definition = next;
    this.save();
    return { ...next, hosts: [...next.hosts] };
  }

  /** Preserves an account's instances as server-owned content when the account is deleted. */
  releaseOwner(ownerId: number): string[] {
    const released: string[] = [];
    const now = new Date().toISOString();
    this.data.instances = this.data.instances.map(definition => {
      if (definition.ownerId !== ownerId) return definition;
      released.push(definition.id);
      const next = { ...definition, ownerId: null, updated: now };
      const runtime = this.runtimes.get(definition.id);
      if (runtime) runtime.definition = next;
      return next;
    });
    if (released.length) this.save();
    return released;
  }

  /**
   * Removes an instance. Metadata and runtimes are updated first, then the whole
   * instance directory is deleted asynchronously so removing a large chart set does
   * not block the event loop.
   */
  async delete(id: string): Promise<boolean> {
    if (id === DEFAULT_INSTANCE_ID) throw new Error("the default instance cannot be deleted");
    const index = this.data.instances.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const definition = this.data.instances[index];
    const root = path.join(this.instanceRoot, id);
    if (path.dirname(root) !== this.instanceRoot) throw new Error("invalid instance directory");
    this.data.instances.splice(index, 1);
    const runtime = this.runtimes.get(id);
    if (runtime) {
      runtime.records.close();
      this.runtimes.delete(id);
    }
    this.save();
    await fs.promises.rm(root, { recursive: true, force: true });
    return Boolean(definition);
  }

  private load(): PersistedInstances {
    if (!fs.existsSync(this.metadataPath)) return { version: 1, instances: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metadataPath, "utf8")) as Partial<PersistedInstances>;
      const instances = Array.isArray(parsed.instances) ? parsed.instances.filter(isDefinition).map((item) => ({
        ...item,
        hosts: cleanHosts(item.hosts),
        ...(item.visibility === undefined ? {} : { visibility: (() => { try { return parseInstanceVisibility(item.visibility); } catch { return { mode: "none" as const, userIds: [] }; } })() }),
      })) : [];
      return { version: 1, instances };
    } catch {
      return { version: 1, instances: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.metadataPath), { recursive: true });
    const temporary = `${this.metadataPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(temporary, this.metadataPath);
  }

  private ensureDefaultInstance(): void {
    const existing = this.get(DEFAULT_INSTANCE_ID);
    if (existing) {
      const next: ChartServiceInstanceDefinition = {
        ...existing,
        // The default instance follows the active .env configuration. This
        // also prevents a test process with temporary paths from changing the
        // production default instance on the next restart.
        chartsPath: this.config.privateChartsPath,
        recordsPath: this.config.privateRecordsPath,
        recordsDatabasePath: this.config.privateRecordsDatabasePath,
        tokenCapturePath: this.config.privateTokenCapturePath,
      };
      const index = this.data.instances.findIndex((item) => item.id === DEFAULT_INSTANCE_ID);
      this.data.instances[index] = next;
      this.save();
      return;
    }
    const now = new Date().toISOString();
    this.data.instances.push({
      id: DEFAULT_INSTANCE_ID,
      name: "默认实例",
      hosts: [],
      enabled: true,
      chartsPath: this.config.privateChartsPath,
      recordsPath: this.config.privateRecordsPath,
      recordsDatabasePath: this.config.privateRecordsDatabasePath,
      tokenCapturePath: this.config.privateTokenCapturePath,
      created: now,
      updated: now,
    });
    this.save();
  }
}

export function instanceIdFromQuery(value: string | null): string {
  return value && INSTANCE_ID_PATTERN.test(value) ? value : DEFAULT_INSTANCE_ID;
}

export { DEFAULT_INSTANCE_ID, INSTANCE_ID_PATTERN };
