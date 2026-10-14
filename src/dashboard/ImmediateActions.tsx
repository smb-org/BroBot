import { useEffect, useMemo, useState, type ComponentType, type ReactElement, type SyntheticEvent } from "react";

import { hasRequiredChannelRole, type ChannelRole, type ChannelStreamState } from "../contracts/values";
import { MODULES } from "../modules/registry";
import type { ModuleImmediateActionCondition, ModuleImmediateActionContentProperties, ModuleImmediateActionDefinition } from "../modules/contract";
import { dashboardCommonTexts, dashboardLanguage, dashboardTexts, immediateActionUnavailableReasonText } from "./locale";
import { evaluateImmediateActionAvailability } from "./immediate-action-availability";
import { loadModuleImmediateActionContent, retryModuleChunkLoad } from "./module-panel-loaders";
import type { PanelModuleState } from "../panel-contract";
import { Button, Icon, LoadStateLines } from "./ui";
import { DialogContent, DialogPrimitive, DialogTitle } from "./ui/primitives/dialog";
import { PopoverContent, PopoverPrimitive } from "./ui/primitives/popover";

type CustomCondition = Extract<ModuleImmediateActionCondition, { check: unknown }>;

interface ActionConditionState {
  loading: boolean;
  reason: Readonly<Record<"de" | "en", string>> | null;
  until: number | null;
}

const remainingTime = (until: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((until - now) / 1_000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
};

const roleReason = (requiredRole: ChannelRole): string => {
  const texts = dashboardTexts().streamManager;
  if (requiredRole === "broadcaster") return texts.broadcasterOnly;
  if (requiredRole === "manager") return texts.managerOnly;
  return texts.operatorOnly;
};

const ActionButton = ({ action, moduleId, channelId, streamState, role }: {
  action: ModuleImmediateActionDefinition;
  moduleId: string;
  channelId: string;
  streamState: ChannelStreamState | null | undefined;
  role: ChannelRole;
}): ReactElement => {
  const language = dashboardLanguage();
  const texts = dashboardTexts();
  const staticAvailability = evaluateImmediateActionAvailability(action.conditions, streamState);
  const meetsRole = hasRequiredChannelRole(role, action.requiredRole);
  const customConditions = useMemo(
    () => action.conditions.filter((condition): condition is CustomCondition => typeof condition !== "string"),
    [action.conditions],
  );
  const shouldCheckConditions = meetsRole && staticAvailability.enabled && customConditions.length > 0;
  const [conditionState, setConditionState] = useState<ActionConditionState>({
    loading: shouldCheckConditions,
    reason: null,
    until: null,
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldCheckConditions) return;
    let active = true;
    let pendingController: AbortController | null = null;
    const check = async (): Promise<void> => {
      pendingController?.abort();
      const controller = new AbortController();
      pendingController = controller;
      setConditionState((current) => ({ ...current, loading: current.reason === null }));
      try {
        for (const condition of customConditions) {
          const result = await condition.check({ channelId, streamState, language, signal: controller.signal });
          if (!active || controller.signal.aborted) return;
          if (result.reason !== null) {
            setConditionState({ loading: false, reason: result.reason, until: result.until ?? null });
            return;
          }
        }
        if (active) setConditionState({ loading: false, reason: null, until: null });
      } catch (error: unknown) {
        if (!active || controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
        setConditionState({
          loading: false,
          reason: { de: texts.streamManager.actionAvailabilityFailed, en: texts.streamManager.actionAvailabilityFailed },
          until: null,
        });
      }
    };
    void check();
    const interval = window.setInterval(() => { void check(); }, 4_000);
    return () => {
      active = false;
      pendingController?.abort();
      window.clearInterval(interval);
    };
  }, [channelId, customConditions, language, shouldCheckConditions, streamState, texts.streamManager.actionAvailabilityFailed]);

  useEffect(() => {
    if (conditionState.until === null || conditionState.reason === null || !conditionState.reason[language].includes("{time}")) return;
    const interval = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(interval); };
  }, [conditionState.reason, conditionState.until, language]);

  const staticReason = staticAvailability.reason;
  const lockReason = !meetsRole
    ? roleReason(action.requiredRole)
    : !staticAvailability.enabled
      ? staticReason === null ? texts.streamManager.actionAvailabilityFailed : immediateActionUnavailableReasonText(staticReason, language)
      : conditionState.loading
        ? texts.streamManager.actionLoading
        : conditionState.reason === null
          ? null
          : conditionState.until === null
            ? conditionState.reason[language]
            : conditionState.reason[language].replace("{time}", remainingTime(conditionState.until, now));

  return <ActionFrame action={action} moduleId={moduleId} channelId={channelId} language={language} disabled={lockReason !== null} reason={lockReason} />;
};

const ActionFrame = ({ action, moduleId, channelId, language, disabled, reason }: {
  action: ModuleImmediateActionDefinition;
  moduleId: string;
  channelId: string;
  language: "de" | "en";
  disabled: boolean;
  reason: string | null;
}): ReactElement => {
  const texts = dashboardTexts();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contentFailed, setContentFailed] = useState(false);
  const [loadedContent, setLoadedContent] = useState<{ actionId: string; component: ComponentType<ModuleImmediateActionContentProperties> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const content = loadedContent?.actionId === action.id ? loadedContent.component : null;
  const contentLoading = open && action.content !== undefined && content === null && !contentFailed;
  const Content = content;
  const reasonId = `live-action-reason-${moduleId}-${action.id}`;

  useEffect(() => {
    if (!open || action.content === undefined || content !== null || contentFailed) return;
    let active = true;
    const loader = loadModuleImmediateActionContent(moduleId, action.id);
    if (loader === null) {
      void Promise.resolve().then(() => { if (active) setContentFailed(true); });
      return () => { active = false; };
    }
    void loader.then((loaded) => {
      if (active) setLoadedContent({ actionId: action.id, component: loaded.default });
    }).catch(() => {
      if (active) setContentFailed(true);
    });
    return () => { active = false; };
  }, [action.content, action.id, channelId, content, contentFailed, moduleId, open]);

  const close = (): void => {
    if (busy) return;
    setOpen(false);
    setError(null);
  };

  const run = async (formData: FormData): Promise<void> => {
    if (disabled || busy || contentLoading || contentFailed) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await action.execute({ channelId, language, formData });
      setResult(texts.streamManager.actionSucceeded(action.name[language]));
      if (action.content !== undefined) setOpen(false);
    } catch {
      setError(action.errorMessage?.[language] ?? texts.streamManager.actionFailed);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run(new FormData(event.currentTarget));
  };

  const buttonContents = <>
    <span className="live-action__icon"><Icon name={action.icon} size={20} /></span>
    <span className="live-action__name">{action.name[language]}</span>
  </>;
  const reasonLine = reason ?? result ?? error ?? "\u00a0";
  const triggerClassName = `live-action__button${reason !== null ? " is-locked" : ""}`;
  const triggerProps = {
    "aria-describedby": reasonId,
    "aria-haspopup": action.content === undefined ? undefined : action.content.presentation === "dialog" ? "dialog" as const : "dialog" as const,
    "aria-busy": busy,
    disabled: disabled || busy,
    title: reason ?? action.name[language],
  };

  const frameBody = <form className="live-action-frame" onSubmit={submit}>
    <header className="live-action-frame__header">
      {action.content?.presentation === "dialog"
        ? <DialogTitle className="live-action-frame__dialog-title">{action.name[language]}</DialogTitle>
        : <h3 className="live-action-frame__popover-title">{action.name[language]}</h3>}
      {action.content?.presentation === "dialog" ? <button className="live-action-frame__close" type="button" aria-label={dashboardCommonTexts().close} disabled={busy} onClick={close}><Icon name="close" /></button> : null}
    </header>
    <div className="live-action-frame__middle" aria-busy={contentLoading || busy}>
      {contentLoading ? <LoadStateLines rows={2} height={42} /> : contentFailed
        ? <div className="live-action-frame__load-error" role="alert">
          <p>{texts.streamManager.actionLoadFailed}</p>
          <Button size="compact" variant="neutral" onClick={retryModuleChunkLoad}>{dashboardCommonTexts().retry}</Button>
        </div>
        : Content === null ? null : <fieldset disabled={busy} className="live-action-frame__fields"><Content channelId={channelId} language={language} /></fieldset>}
    </div>
    <p className={`live-action-frame__error${error === null ? "" : " has-error"}`} aria-live="polite" role="status">{error ?? "\u00a0"}</p>
    <footer className="live-action-frame__footer">
      <Button variant="subtle" disabled={busy} onClick={close}>{texts.streamManager.actionCancel}</Button>
      <Button variant="primary" type="submit" disabled={disabled || busy || contentLoading || contentFailed}>
        {busy ? texts.streamManager.actionRunning : texts.streamManager.actionRun}
      </Button>
    </footer>
  </form>;

  if (action.content?.presentation === "popover") {
    return <div className="live-action">
      <PopoverPrimitive.Root open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); if (next) setError(null); } }}>
        <PopoverPrimitive.Trigger {...triggerProps} type="button" className={triggerClassName}>{buttonContents}</PopoverPrimitive.Trigger>
        <p id={reasonId} className={`live-action__reason${reason !== null ? " is-locked" : ""}`} title={reason ?? result ?? error ?? undefined}>{reasonLine}</p>
        <PopoverContent align="start" side="bottom" className="live-action-frame-popover">{frameBody}</PopoverContent>
      </PopoverPrimitive.Root>
    </div>;
  }

  if (action.content?.presentation === "dialog") {
    return <div className="live-action">
      <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); if (next) setError(null); } }}>
        <DialogPrimitive.Trigger {...triggerProps} type="button" className={triggerClassName}>{buttonContents}</DialogPrimitive.Trigger>
        <p id={reasonId} className={`live-action__reason${reason !== null ? " is-locked" : ""}`} title={reason ?? result ?? error ?? undefined}>{reasonLine}</p>
        <DialogContent className="live-action-frame-dialog">
          {frameBody}
        </DialogContent>
      </DialogPrimitive.Root>
    </div>;
  }

  return <div className="live-action">
    <button {...triggerProps} className={triggerClassName} type="button" onClick={() => { void run(new FormData()); }}>{buttonContents}</button>
    <p id={reasonId} className={`live-action__reason${reason !== null ? " is-locked" : error !== null ? " has-error" : ""}`} title={reason ?? result ?? error ?? undefined} aria-live="polite">{reasonLine}</p>
  </div>;
};

export const ImmediateActions = ({ channelId, streamState, role, modules = [], modulesLoaded = true }: {
  channelId: string;
  streamState?: ChannelStreamState | null | undefined;
  role: ChannelRole;
  modules?: readonly Pick<PanelModuleState, "id" | "enabled">[];
  modulesLoaded?: boolean;
}): ReactElement => {
  const texts = dashboardTexts();
  const moduleStates = new Map(modules.map((module) => [module.id, module.enabled]));
  const actions = MODULES.flatMap((module) => module.actions === undefined || moduleStates.get(module.id) !== true
    ? []
    : module.actions.map((action) => ({ moduleId: module.id, action })));
  const count = texts.streamManager.actionCount(String(actions.length));

  return <section className="live-cockpit-actions" aria-label={texts.streamManager.immediateActions}>
    <header className="live-cockpit-actions__heading">
      <div><h2>{texts.streamManager.immediateActions}</h2><p>{texts.liveCockpit.actionsHint}</p></div>
      <span className="live-cockpit-actions__count">{count}</span>
    </header>
    <div className="live-cockpit-actions__grid" role="group" aria-label={texts.streamManager.immediateActions}>
      {modulesLoaded
        ? actions.map(({ moduleId, action }) => <ActionButton key={`${moduleId}:${action.id}`} action={action} moduleId={moduleId} channelId={channelId} streamState={streamState} role={role} />)
        : <div className="live-cockpit-actions__loading" aria-hidden="true"><LoadStateLines rows={3} height={64} /></div>}
    </div>
    <p className="live-cockpit-actions__role">{texts.liveCockpit.roleLabel}: {texts.liveCockpit.roles[role]}</p>
  </section>;
};
