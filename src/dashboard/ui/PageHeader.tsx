import type { ReactElement, ReactNode, RefCallback } from "react";

import { dashboardCommonTexts } from "../locale";
import { NavigationIcon } from "./NavigationIcon";
import { Icon } from "./Icon";
import { Switch } from "./primitives/switch";
import { HeaderActions } from "./HeaderActions";
import type { SaveStatusProps } from "./SaveStatus";

interface ModuleStatusSwitchProps {
  title: string;
  active: boolean;
  onToggle: (active: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
}

function ModuleStatusSwitch({ title, active, onToggle, disabled = false, busy = false }: ModuleStatusSwitchProps): ReactElement {
  const texts = dashboardCommonTexts();
  return (
    <div className={`module-status-switch${active ? " is-on" : ""}`}>
      <Switch aria-label={title} aria-busy={busy} checked={active} disabled={disabled || busy} onCheckedChange={onToggle} />
      <span>{active ? texts.activeModule : texts.pausedModule}</span>
    </div>
  );
}

export interface PageHeaderProps {
  kind?: string;
  title: string;
  titleContent?: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode | null;
  active?: boolean;
  onToggle?: (active: boolean) => void;
  switchDisabled?: boolean;
  switchBusy?: boolean;
  switchTitle?: string;
  moduleSwitch?: ReactNode;
  badge?: ReactNode;
  badges?: ReactNode;
  saveStatus?: ReactNode;
  save?: SaveStatusProps;
  saveTargetRef?: RefCallback<HTMLDivElement>;
  actions?: ReactNode;
  pageActions?: ReactNode;
  overflow?: ReactNode;
  lockHint?: string;
  reserveLockHint?: boolean;
  headingLevel?: "h1" | "h2" | "h3";
}

export function PageHeader({
  kind = "module",
  title,
  titleContent,
  subtitle,
  meta,
  icon,
  active,
  onToggle,
  switchDisabled = false,
  switchBusy = false,
  switchTitle = title,
  moduleSwitch,
  badge,
  badges,
  saveStatus,
  save,
  saveTargetRef,
  actions,
  pageActions,
  overflow,
  lockHint,
  reserveLockHint = false,
  headingLevel = "h1",
}: PageHeaderProps): ReactElement {
  const common = dashboardCommonTexts();
  const switchControl = moduleSwitch ?? (active === undefined || onToggle === undefined
    ? null
    : <ModuleStatusSwitch title={switchTitle} active={active} onToggle={onToggle} disabled={switchDisabled} busy={switchBusy} />);
  const headerActions = actions === undefined ? pageActions : pageActions === undefined ? actions : <>{actions}{pageActions}</>;
  const headerMeta = lockHint === undefined
    ? reserveLockHint
      ? <>{meta}{meta === undefined ? null : " "}<span className="page-header__lock page-header__lock--reserved" aria-hidden="true" /></>
      : meta
    : <>{meta}{meta === undefined ? null : " "}<span className="page-header__lock"><Icon name="lock" size={16} />{lockHint}</span></>;
  const metaContent = reserveLockHint
    ? <div className="page-header__meta">
      {meta === undefined || meta === null || meta === "" ? null : <div className="page-header__meta-content">{meta}</div>}
      <div className="page-header__lock-row">
        {lockHint === undefined
          ? <span className="page-header__lock--reserved" aria-hidden="true" />
          : <span className="page-header__lock"><Icon name="lock" size={16} /><span>{lockHint}</span></span>}
      </div>
    </div>
    : headerMeta === undefined || headerMeta === null || headerMeta === ""
      ? null
      : <div className="page-header__meta">{headerMeta}</div>;
  const Heading = headingLevel;

  return (
    <header data-ui="" className="page-header module-detail-heading">
      {icon === null ? null : <div className="page-header__icon module-detail__icon module-detail-heading__icon" aria-hidden="true">
        {icon === undefined ? <NavigationIcon kind={kind} className="module-heading-glyph" /> : icon}
      </div>}
      <div className="page-header__main page-header__copy module-detail-heading__copy">
        <div className="page-header__title-row">
          <Heading>{titleContent ?? title}</Heading>
          {switchControl === null ? null : <div className="page-header__module-switch module-detail__switch">{switchControl}</div>}
          {(badges ?? badge) === undefined || (badges ?? badge) === null ? null : <div className="page-header__badges">{badges ?? badge}</div>}
        </div>
        {subtitle === undefined || subtitle === null || subtitle === "" ? null : <p>{subtitle}</p>}
        {metaContent}
      </div>
      <HeaderActions
        saveStatus={saveStatus}
        {...(save === undefined ? {} : { save })}
        {...(saveTargetRef === undefined ? {} : { saveTargetRef })}
        {...(headerActions === undefined ? {} : { pageActions: headerActions })}
        {...(overflow === undefined ? {} : { overflow })}
        moreActionsLabel={common.moreActions}
      />
    </header>
  );
}
