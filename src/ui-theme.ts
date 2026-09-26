/** Shared local-only brand tokens for the public page and administration UI. */
export function phiraThemeCss(): string {
  return `:root{
    --bg:#101617;--surface:#141c1e;--panel:#182123;--control:#202c2e;--input:#111a1c;
    --accent:#a9e8cc;--accent-hover:#c4f4df;--on-accent:#16362b;
    --text:#e9efef;--text-secondary:#c0cecf;--muted:#92a3a4;--line:#2b383a;
    --danger:#ffaaaa;--danger-surface:#352527;--focus:#c4f4df;
    font-family:Inter,"Segoe UI","Microsoft YaHei",system-ui,sans-serif
  }`;
}
