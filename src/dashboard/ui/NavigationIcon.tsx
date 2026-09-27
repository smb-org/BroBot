import type { ReactElement } from "react";

export function NavigationIcon({ kind, className = "navigation-icon" }: { kind: string; className?: string }): ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {kind === "overview" ? <><path d="M4 12a8 8 0 1 1 16 0" /><path d="m12 12 4-3M6 17h12" /><circle cx="12" cy="12" r="1" /></>
        : kind === "channel" ? <><path d="M5 7.5h14M5 12h14M5 16.5h9" /><circle cx="18" cy="16.5" r="1" />
          </>
          : kind === "system" ? <><circle cx="12" cy="12" r="7" /><path d="M12 8v4l2.5 2" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
            </>
            : kind === "members" ? <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.6-3.4 2.4-5 5.5-5s4.9 1.6 5.5 5M16 6.5a2.5 2.5 0 0 1 0 5M17 14c2.1.5 3.2 2.1 3.5 4" />
              </>
              : kind === "modules" ? <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>
                : kind === "texts" ? <><path d="M5 4.5h10a4 4 0 0 1 4 4v11H9a4 4 0 0 0-4 1.5zM5 4.5v15M9 9h6M9 12.5h6M9 16h4" />
                  </>
                  : kind === "permission" ? <><circle cx="8.5" cy="15.5" r="3.5" /><path d="m11 13 7-7 2 2-7 7M16 8l2 2" />
                  </>
                  : kind === "token" || kind === "overlays" ? <><rect x="4" y="5" width="13" height="14" rx="1.5" /><path d="M8 3h12v14M8 10h5M8 14h5" /></>
                    : kind === "variable" ? <><path d="M8 5C5 5 5 7 5 9v1c0 1.5-1 2-2 2 1 0 2 .5 2 2v1c0 2 0 4 3 4M16 5c3 0 3 2 3 4v1c0 1.5 1 2 2 2-1 0-2 .5-2 2v1c0 2 0 4-3 4" /><path d="m10 15 4-6" /><circle cx="10" cy="9" r=".8" /><circle cx="14" cy="15" r=".8" /></>
                      : kind === "platform" ? <><path d="M4 20V6l8-3 8 3v14M2 20h20M9 20v-4h6v4M8 8h1M15 8h1M8 12h1M15 12h1" /></>
                        : kind === "audit" ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2M7 3l-2 2M17 3l2 2" /></>
                          : kind === "weather" ? <><path d="M6 15a3 3 0 0 1 .6-5.94A4.5 4.5 0 0 1 17 10h.5a2.5 2.5 0 1 1 0 5H6Z" /><path d="m9 18-1 2M14 18l-1 2M19 18l-1 2" /></>
                            : kind === "timers" ? <><circle cx="12" cy="13" r="8" /><path d="M12 8v5l3 2M9 2h6M12 2v3M18 6l1.5-1.5" /></>
                            : kind === "events" ? <><path d="M5 4h14v16H5zM8 8h8M8 12h5M8 16h8" /><circle cx="16" cy="12" r="1" /></>
                            : <><path d="M6 5h12v14H6z" /><path d="M9 9h6M9 13h6M9 17h4" /></>}
    </svg>
  );
}
