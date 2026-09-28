/** Shared color and glass tokens for the public page and administration UI. */
export function phiraThemeCss(): string {
  return `:root{
    color-scheme:light;
    --bg:#FBFFD9;--surface:rgba(251,255,217,.68);--panel:rgba(251,255,217,.62);--control:rgba(251,255,217,.82);--input:rgba(251,255,217,.58);
    --accent:#5AA4AE;--accent-ink:#245A63;--accent-hover:#72B4BC;
    --action-bg:#443959;--on-action:#FBFFD9;
    --text:#443959;--text-secondary:#55496B;--muted:#625B70;--link:#245A63;
    --line:rgba(68,57,89,.20);--glass-border:rgba(68,57,89,.18);--glass-shadow:rgba(68,57,89,.14);
    --focus:#245A63;--overlay:rgba(68,57,89,.28);
    --success-surface:rgba(90,164,174,.16);--success-border:rgba(36,90,99,.30);--success-text:#245A63;
    --danger:#873B4A;--danger-surface:rgba(135,59,74,.10);--danger-border:rgba(135,59,74,.28);
    --ambient-cyan:rgba(90,164,174,.15);--ambient-purple:rgba(68,57,89,.10);--grid-line:rgba(68,57,89,.12);
    font-family:Inter,"Segoe UI","Microsoft YaHei",system-ui,sans-serif
  }
  @media(prefers-color-scheme:dark){:root:not([data-theme]){
    color-scheme:dark;
    --bg:#000000;--surface:rgba(16,16,18,.82);--panel:rgba(20,20,23,.76);--control:rgba(34,34,38,.88);--input:rgba(8,8,10,.78);
    --action-bg:#FBFFD9;--on-action:#443959;
    --text:#FBFFD9;--text-secondary:#F0EFD2;--muted:#D8D5BD;--link:#FBFFD9;
    --line:rgba(251,255,217,.18);--glass-border:rgba(251,255,217,.17);--glass-shadow:rgba(0,0,0,.48);
    --focus:#5AA4AE;--overlay:rgba(0,0,0,.62);
    --success-surface:rgba(90,164,174,.20);--success-border:rgba(90,164,174,.42);--success-text:#FBFFD9;
    --danger:#FFD0D5;--danger-surface:rgba(135,59,74,.30);--danger-border:rgba(255,208,213,.28);
    --ambient-cyan:rgba(90,164,174,.11);--ambient-purple:rgba(255,255,255,.045);--grid-line:rgba(251,255,217,.10)
  }
  }
  :root[data-theme="dark"]{
    color-scheme:dark;
    --bg:#000000;--surface:rgba(16,16,18,.82);--panel:rgba(20,20,23,.76);--control:rgba(34,34,38,.88);--input:rgba(8,8,10,.78);
    --action-bg:#FBFFD9;--on-action:#443959;
    --text:#FBFFD9;--text-secondary:#F0EFD2;--muted:#D8D5BD;--link:#FBFFD9;
    --line:rgba(251,255,217,.18);--glass-border:rgba(251,255,217,.17);--glass-shadow:rgba(0,0,0,.48);
    --focus:#5AA4AE;--overlay:rgba(0,0,0,.62);
    --success-surface:rgba(90,164,174,.20);--success-border:rgba(90,164,174,.42);--success-text:#FBFFD9;
    --danger:#FFD0D5;--danger-surface:rgba(135,59,74,.30);--danger-border:rgba(255,208,213,.28);
    --ambient-cyan:rgba(90,164,174,.11);--ambient-purple:rgba(255,255,255,.045);--grid-line:rgba(251,255,217,.10)
  }`;
}
