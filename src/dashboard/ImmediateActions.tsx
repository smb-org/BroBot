import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactElement, type SyntheticEvent } from "react";

import { hasRequiredChannelRole, type ChannelRole, type ChannelStreamState } from "../contracts/values";
import { MODULES } from "../modules/registry";
import type { ModuleImmediateActionCondition, ModuleImmediateActionContentProperties, ModuleImmediateActionDefinition, ModuleImmediateActionResult } from "../modules/contract";
import { dashboardCommonTexts, dashboardLanguage, dashboardTexts, immediateActionUnavailableReasonText } from "./locale";
import { evaluateImmediateActionAvailability } from "./immediate-action-availability";
import { immediateActionErrorFeedback } from "./immediate-action-errors";
import { loadModuleImmediateActionContent, retryModuleChunkLoad } from "./module-panel-loaders";
import type { PanelModuleState } from "../panel-contract";
import { Button, ConfirmDialog, Icon, LoadStateLines, registerDashboardNavigationGuard, useDraftGuard } from "./ui";
import { DialogContent, DialogPrimitive, DialogTitle } from "./ui/primitives/dialog";
import { PopoverContent, PopoverPrimitive } from "./ui/primitives/popover";

type CustomCondition = Extract<ModuleImmediateActionCondition, { check: unknown }>;

interface ActionConditionState {
  channelId: string;
  loading: boolean;
  reason: Readonly<Record<"de" | "en", string>> | null;
  link: { href: string; label: string } | null;
  until: number | null;
  pollId: string | null;
  stale: boolean;
}

interface ActionFeedback {
  message: string;
  href?: string;
  linkLabel?: string;
  until?: number;
  /** Availability generation at the time of an error result that carries a link; a later confirmation supersedes it. */
  supersededByConfirmationAfter?: number;
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

const ActionButton = ({ action, moduleId, channelId, viewerUserId, streamState, botConnected, role, availabilityRetryGeneration, onAvailabilityStateChange, onActionStart, onActionResult, onActionFailure, onFeedbackMessage }: {
  action: ModuleImmediateActionDefinition;
  moduleId: string;
  channelId: string;
  viewerUserId?: string | null;
  streamState: ChannelStreamState | null | undefined;
  botConnected?: boolean | null | undefined;
  role: ChannelRole;
  availabilityRetryGeneration: number;
  onAvailabilityStateChange: (actionKey: string, stale: boolean) => void;
  onActionStart?: (moduleId: string, actionId: string) => number;
  onActionResult?: (moduleId: string, result: ModuleImmediateActionResult, observedAt: number) => void;
  onActionFailure?: (moduleId: string, actionId: string, observedAt: number) => void;
  onFeedbackMessage?: (message: string, link?: { href: string; label: string }, tone?: ModuleImmediateActionResult["tone"]) => void;
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
    channelId,
    loading: shouldCheckConditions,
    reason: null,
    link: null,
    until: null,
    pollId: null,
    stale: false,
  });
  const activeConditionState = conditionState.channelId === channelId ? conditionState : {
    channelId,
    loading: shouldCheckConditions,
    reason: null,
    link: null,
    until: null,
    pollId: null,
    stale: false,
  };
  const [now, setNow] = useState(() => Date.now());
  const [availabilityConfirmations, setAvailabilityConfirmations] = useState(0);
  const actionKey = `${moduleId}:${action.id}`;

  useEffect(() => {
    if (!shouldCheckConditions) {
      onAvailabilityStateChange(actionKey, false);
      return;
    }
    let active = true;
    let inFlight = false;
    let pendingController: AbortController | null = null;
    const check = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      pendingController = controller;
      const timeout = window.setTimeout(() => {
        if (!active) return;
        controller.abort();
        setConditionState((current) => ({
          channelId,
          loading: false,
          reason: null,
          link: null,
          until: null,
          pollId: current.channelId === channelId ? current.pollId : null,
          stale: true,
        }));
        onAvailabilityStateChange(actionKey, true);
      }, 10_000);
      setConditionState((current) => current.channelId === channelId
        ? { ...current, loading: current.reason === null && !current.stale }
        : { channelId, loading: true, reason: null, link: null, until: null, pollId: null, stale: false });
      try {
        let pollId: string | null = null;
        for (const condition of customConditions) {
          const result = await condition.check({ channelId, ...(viewerUserId === undefined ? {} : { viewerUserId }), streamState, botConnected, language, signal: controller.signal });
          if (!active || controller.signal.aborted) return;
          pollId = result.pollId ?? pollId;
          if (result.reason !== null) {
            setConditionState({
              channelId,
              loading: false,
              reason: result.reason,
              link: result.link === undefined ? null : { href: result.link.href, label: result.link.label[language] },
              until: result.until ?? null,
              pollId,
              stale: false,
            });
            onAvailabilityStateChange(actionKey, false);
            return;
          }
        }
        if (active) {
          setConditionState({ channelId, loading: false, reason: null, link: null, until: null, pollId, stale: false });
          setAvailabilityConfirmations((count) => count + 1);
          onAvailabilityStateChange(actionKey, false);
        }
      } catch {
        if (!active) return;
        setConditionState((current) => ({
          channelId,
          loading: false,
          reason: null,
          link: null,
          until: null,
          pollId: current.channelId === channelId ? current.pollId : null,
          stale: true,
        }));
        onAvailabilityStateChange(actionKey, true);
      } finally {
        window.clearTimeout(timeout);
        if (pendingController === controller) pendingController = null;
        inFlight = false;
      }
    };
    void check();
    const interval = window.setInterval(() => { void check(); }, 4_000);
    return () => {
      active = false;
      pendingController?.abort();
      window.clearInterval(interval);
    };
  }, [actionKey, availabilityRetryGeneration, botConnected, channelId, customConditions, language, onAvailabilityStateChange, shouldCheckConditions, streamState, viewerUserId]);

  useEffect(() => {
    if (activeConditionState.until === null || activeConditionState.reason === null || !activeConditionState.reason[language].includes("{time}")) return;
    const interval = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(interval); };
  }, [activeConditionState.reason, activeConditionState.until, language]);

  const staticReason = staticAvailability.reason;
  const lockReason = !meetsRole
    ? roleReason(action.requiredRole)
    : !staticAvailability.enabled
      ? staticReason === null ? texts.streamManager.actionAvailabilityFailed : immediateActionUnavailableReasonText(staticReason, language)
      : activeConditionState.loading
        ? texts.streamManager.actionLoading
        : activeConditionState.reason === null
          ? activeConditionState.stale && activeConditionState.pollId === null && moduleId === "chat_voting" && action.id === "end-vote"
            ? texts.streamManager.actionAvailabilityFailed
            : null
          : activeConditionState.until === null
            ? activeConditionState.reason[language]
            : activeConditionState.reason[language].replace("{time}", remainingTime(activeConditionState.until, now));

  return <ActionFrame action={action} moduleId={moduleId} channelId={channelId} {...(viewerUserId === undefined ? {} : { viewerUserId })} language={language} pollId={activeConditionState.pollId}
    disabled={lockReason !== null} reason={lockReason} availabilityStale={activeConditionState.stale}
    availabilityConfirmations={availabilityConfirmations}
    availabilityLink={shouldCheckConditions && activeConditionState.reason !== null ? activeConditionState.link : null}
    {...(onFeedbackMessage === undefined ? {} : { onFeedbackMessage })}
    {...(onActionStart === undefined ? {} : { onActionStart })}
    {...(onActionResult === undefined ? {} : { onActionResult })}
    {...(onActionFailure === undefined ? {} : { onActionFailure })} />;
};

const ActionFrame = ({ action, moduleId, channelId, viewerUserId, language, pollId, disabled, reason, availabilityStale, availabilityConfirmations, availabilityLink, onActionStart, onActionResult, onActionFailure, onFeedbackMessage }: {
  action: ModuleImmediateActionDefinition;
  moduleId: string;
  channelId: string;
  viewerUserId?: string | null;
  language: "de" | "en";
  pollId: string | null;
  disabled: boolean;
  reason: string | null;
  availabilityStale: boolean;
  availabilityConfirmations: number;
  availabilityLink: { href: string; label: string } | null;
  onActionStart?: (moduleId: string, actionId: string) => number;
  onActionResult?: (moduleId: string, result: ModuleImmediateActionResult, observedAt: number) => void;
  onActionFailure?: (moduleId: string, actionId: string, observedAt: number) => void;
  onFeedbackMessage?: (message: string, link?: { href: string; label: string }, tone?: ModuleImmediateActionResult["tone"]) => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [contentFailed, setContentFailed] = useState(false);
  const [loadedContent, setLoadedContent] = useState<{ actionId: string; component: ComponentType<ModuleImmediateActionContentProperties> } | null>(null);
  const [contentReadiness, setContentReadiness] = useState<{ actionId: string; channelId: string; generation: number; ready: boolean; reason: string | null } | null>(null);
  const [contentReadinessGeneration, setContentReadinessGeneration] = useState(0);
  const [error, setError] = useState<ActionFeedback | null>(null);
  const [savedResult, setResult] = useState<ActionFeedback | null>(null);
  const [feedbackNow, setFeedbackNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const confirmationsRef = useRef(availabilityConfirmations);
  // A linked error result (for example a missing permission) is superseded once a later availability check confirms the action again.
  const result = savedResult?.supersededByConfirmationAfter !== undefined && availabilityConfirmations > savedResult.supersededByConfirmationAfter
    ? null
    : savedResult;
  const content = loadedContent?.actionId === action.id ? loadedContent.component : null;
  const contentLoading = open && action.content !== undefined && content === null && !contentFailed;
  const requiresContentReadiness = action.content?.requiresReadiness === true;
  const currentContentReadiness = contentReadiness?.actionId === action.id && contentReadiness.channelId === channelId &&
    contentReadiness.generation === contentReadinessGeneration
    ? contentReadiness
    : null;
  const contentReady = !requiresContentReadiness || currentContentReadiness?.ready === true;
  const contentReadinessReason = !requiresContentReadiness || contentReady
    ? null
    : currentContentReadiness?.reason ?? texts.streamManager.actionLoading;
  const contentReadinessReasonId = `live-action-readiness-${moduleId}-${action.id}`;
  const Content = content;
  const reasonId = `live-action-reason-${moduleId}-${action.id}`;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => { confirmationsRef.current = availabilityConfirmations; }, [availabilityConfirmations]);

  const discardDraft = (): void => {
    setOpen(false);
    setDraftDirty(false);
    setError(null);
  };
  const navigationGuard = useDraftGuard(draftDirty, () => Promise.resolve(null), discardDraft);

  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);

  useEffect(() => {
    if (error?.until === undefined) return;
    const interval = window.setInterval(() => { setFeedbackNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(interval); };
  }, [error?.until]);

  const feedbackMessage = (feedback: ActionFeedback): string => feedback.until === undefined
    ? feedback.message
    : feedback.message.replace("{time}", remainingTime(feedback.until, feedbackNow));

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

  const closeNow = (): void => {
    if (busy) return;
    setOpen(false);
    setDraftDirty(false);
    setError(null);
  };

  const close = (): void => {
    if (busy) return;
    navigationGuard.guardSwitch(closeNow);
  };

  const openAction = (): void => {
    if (busy) return;
    if (requiresContentReadiness) {
      setContentReadiness(null);
      setContentReadinessGeneration((generation) => generation + 1);
    }
    setOpen(true);
    setDraftDirty(false);
    setError(null);
  };

  const reportContentReadiness = useCallback((ready: boolean, readinessReason: string | null): void => {
    setContentReadiness((current) => current?.actionId === action.id && current.channelId === channelId &&
      current.generation === contentReadinessGeneration && current.ready === ready && current.reason === readinessReason
      ? current
      : { actionId: action.id, channelId, generation: contentReadinessGeneration, ready, reason: readinessReason });
  }, [action.id, channelId, contentReadinessGeneration]);

  const run = async (formData: FormData): Promise<void> => {
    if (disabled || busy || contentLoading || contentFailed || !contentReady) return;
    const isCurrentRequest = (): boolean => mounted.current;
    setBusy(true);
    setError(null);
    setResult(null);
    const observedAt = onActionStart?.(moduleId, action.id) ?? Date.now();
    try {
      const actionResult = await action.execute({ channelId, ...(viewerUserId === undefined ? {} : { viewerUserId }), language, formData, ...(pollId === null ? {} : { pollId }) });
      if (!isCurrentRequest()) return;
      setResult({
        message: actionResult?.message?.[language] ?? texts.streamManager.actionSucceeded(action.name[language]),
        ...(actionResult?.link === undefined ? {} : { href: actionResult.link.href, linkLabel: actionResult.link.label[language] }),
        ...(actionResult?.link !== undefined && actionResult.tone === "error" ? { supersededByConfirmationAfter: confirmationsRef.current } : {}),
      });
      onFeedbackMessage?.(
        actionResult?.message?.[language] ?? texts.streamManager.actionSucceeded(action.name[language]),
        actionResult?.link === undefined ? undefined : { href: actionResult.link.href, label: actionResult.link.label[language] },
        actionResult?.tone,
      );
      if (actionResult !== undefined) onActionResult?.(moduleId, actionResult, observedAt);
      if (action.content !== undefined) {
        setDraftDirty(false);
        setOpen(false);
      }
    } catch (caught: unknown) {
      if (!isCurrentRequest()) return;
      onActionFailure?.(moduleId, action.id, observedAt);
      const feedback = immediateActionErrorFeedback(caught, moduleId,
        action.errorMessage?.[language] ?? texts.streamManager.actionFailed, language);
      setError({ message: feedback.message, ...(feedback.until === null ? {} : { until: feedback.until }) });
      onFeedbackMessage?.(feedback.message);
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run(new FormData(event.currentTarget));
  };

  const reasonLine = reason ?? (availabilityStale ? texts.streamManager.actionAvailabilityStale : error !== null ? feedbackMessage(error) : result?.message ?? "\u00a0");
  const actionResultLink = result?.href === undefined || result.linkLabel === undefined
    ? null
    : { href: result.href, label: result.linkLabel, message: result.message };
  const resultLink = actionResultLink ?? (availabilityLink === null ? null : {
    ...availabilityLink,
    message: reason ?? "",
  });
  const hasResultLink = resultLink !== null;
  const popoverTitleId = `${reasonId}-popover-title`;
  const availabilityWarning = availabilityStale || reason === texts.streamManager.actionAvailabilityFailed;
  const buttonContents = <>
    <span className="live-action__icon"><Icon name={action.icon} size={20} /></span>
    <span className="live-action__name">{action.name[language]}</span>
    <span id={reasonId} className={hasResultLink ? "sr-only" : `live-action__reason${reason !== null ? " is-locked" : error !== null ? " has-error" : ""}${availabilityWarning ? " is-availability-warning" : ""}`} aria-live="polite">{reasonLine}</span>
  </>;
  const hasReason = reason !== null || availabilityStale || error !== null || result !== null;
  const triggerClassName = `live-action__button${reason !== null ? " is-locked" : ""}${hasReason ? " has-reason" : ""}`;
  const triggerProps = {
    "aria-label": action.name[language],
    "aria-describedby": reasonId,
    "aria-haspopup": action.content === undefined ? undefined : "dialog" as const,
    "aria-busy": busy,
    disabled: disabled || busy,
    title: reason ?? action.name[language],
  };

  const frameBody = <form className="live-action-frame" onSubmit={submit}>
    <header className="live-action-frame__header">
      {action.content?.presentation === "dialog"
        ? <DialogTitle className="live-action-frame__dialog-title">{action.name[language]}</DialogTitle>
        : <h3 id={popoverTitleId} className="live-action-frame__popover-title">{action.name[language]}</h3>}
      {action.content?.presentation === "dialog" ? <button className="live-action-frame__close" type="button" aria-label={dashboardCommonTexts().close} disabled={busy} onClick={close}><Icon name="close" /></button> : null}
    </header>
    <div className="live-action-frame__middle" aria-busy={contentLoading || busy}>
      {contentLoading ? <LoadStateLines rows={2} height={42} /> : contentFailed
        ? <div className="live-action-frame__load-error" role="alert">
          <p>{texts.streamManager.actionLoadFailed}</p>
          <Button size="compact" variant="neutral" onClick={retryModuleChunkLoad}>{dashboardCommonTexts().retry}</Button>
        </div>
        : Content === null ? null : <fieldset disabled={busy} className="live-action-frame__fields"><Content channelId={channelId} language={language} onDraftChange={setDraftDirty}
          {...(requiresContentReadiness ? { onReadinessChange: reportContentReadiness } : {})} /></fieldset>}
    </div>
    {contentReadinessReason === null ? null : <span className="sr-only" id={contentReadinessReasonId}>{contentReadinessReason}</span>}
    <p className={`live-action-frame__error${error === null ? "" : " has-error"}`} aria-live="polite" role="status">{error === null ? "\u00a0" : feedbackMessage(error)}</p>
    <footer className="live-action-frame__footer">
      <Button variant="subtle" disabled={busy} onClick={close}>{texts.streamManager.actionCancel}</Button>
      <Button variant="primary" type="submit" disabled={disabled || busy || contentLoading || contentFailed || !contentReady}
        {...(contentReadinessReason === null ? {} : { describedBy: contentReadinessReasonId, title: contentReadinessReason })}>
        {busy ? texts.streamManager.actionRunning : texts.streamManager.actionRun}
      </Button>
    </footer>
  </form>;

  if (action.content?.presentation === "popover") {
    return <div className="live-action">
      <PopoverPrimitive.Root open={open} onOpenChange={(next) => { if (next) openAction(); else close(); }}>
        <PopoverPrimitive.Trigger {...triggerProps} type="button" className={triggerClassName}>{buttonContents}</PopoverPrimitive.Trigger>
        <PopoverContent aria-labelledby={popoverTitleId} align="start" side="bottom" className="live-action-frame-popover">{frameBody}</PopoverContent>
      </PopoverPrimitive.Root>
      <ConfirmDialog
        opened={navigationGuard.confirmOpen}
        title={texts.liveCockpit.actionDraftDiscardTitle}
        description={texts.liveCockpit.actionDraftDiscardDescription}
        confirmLabel={texts.liveCockpit.actionDraftDiscard}
        cancelLabel={texts.liveCockpit.actionDraftContinue}
        danger
        onCancel={navigationGuard.continueEditing}
        onConfirm={navigationGuard.discardAndSwitch}
      />
    </div>;
  }

  if (action.content?.presentation === "dialog") {
    return <div className="live-action">
      <DialogPrimitive.Root open={open} modal="trap-focus" onOpenChange={(next) => { if (next) openAction(); else close(); }}>
        <DialogPrimitive.Trigger {...triggerProps} type="button" className={triggerClassName}>{buttonContents}</DialogPrimitive.Trigger>
        <DialogContent className="live-action-frame-dialog">
          {frameBody}
        </DialogContent>
      </DialogPrimitive.Root>
      <ConfirmDialog
        opened={navigationGuard.confirmOpen}
        title={texts.liveCockpit.actionDraftDiscardTitle}
        description={texts.liveCockpit.actionDraftDiscardDescription}
        confirmLabel={texts.liveCockpit.actionDraftDiscard}
        cancelLabel={texts.liveCockpit.actionDraftContinue}
        danger
        onCancel={navigationGuard.continueEditing}
        onConfirm={navigationGuard.discardAndSwitch}
      />
    </div>;
  }

  return <div className="live-action">
    <button {...triggerProps} className={triggerClassName} type="button" onClick={() => { void run(new FormData()); }}>{buttonContents}</button>
    {resultLink !== null && actionResultLink === null
      ? <div className="live-action__availability-link">
        <span className="live-action__availability-message">{resultLink.message}</span>
        <a href={resultLink.href}>{resultLink.label}</a>
      </div>
      : null}
    {actionResultLink === null ? null : <a className="live-action__result-link" href={actionResultLink.href}
      target="_blank" rel="noreferrer"
      aria-label={`${actionResultLink.message} ${actionResultLink.label}`}>
      <span className="live-action__result-message">{actionResultLink.message}</span>
      <span>{actionResultLink.label}</span>
    </a>}
  </div>;
};

export const ImmediateActions = ({ channelId, viewerUserId, streamState, botConnected, role, modules = [], modulesLoaded = true, onActionStart, onActionResult, onActionFailure, onFeedbackMessage }: {
  channelId: string;
  viewerUserId?: string | null;
  streamState?: ChannelStreamState | null | undefined;
  botConnected?: boolean | null;
  role: ChannelRole;
  modules?: readonly Pick<PanelModuleState, "id" | "enabled">[];
  modulesLoaded?: boolean;
  onActionStart?: (moduleId: string, actionId: string) => number;
  onActionResult?: (moduleId: string, result: ModuleImmediateActionResult, observedAt: number) => void;
  onActionFailure?: (moduleId: string, actionId: string, observedAt: number) => void;
  onFeedbackMessage?: (message: string, link?: { href: string; label: string }, tone?: ModuleImmediateActionResult["tone"]) => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const moduleStates = new Map(modules.map((module) => [module.id, module.enabled]));
  const actions = MODULES.flatMap((module) => module.actions === undefined || moduleStates.get(module.id) !== true
    ? []
    : module.actions.map((action) => ({ moduleId: module.id, action })));
  const count = texts.streamManager.actionCount(actions.length);
  const [staleActionKeys, setStaleActionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [availabilityRetryGeneration, setAvailabilityRetryGeneration] = useState(0);
  const onAvailabilityStateChange = useCallback((actionKey: string, stale: boolean): void => {
    setStaleActionKeys((current) => {
      if (stale === current.has(actionKey)) return current;
      const next = new Set(current);
      if (stale) next.add(actionKey);
      else next.delete(actionKey);
      return next;
    });
  }, []);
  const retryAvailability = (): void => {
    setStaleActionKeys(new Set());
    setAvailabilityRetryGeneration((generation) => generation + 1);
  };

  return <section className="live-cockpit-actions" aria-label={texts.streamManager.immediateActions}>
    <header className="live-cockpit-actions__heading">
      <div><h2>{texts.streamManager.immediateActions}</h2><p>{texts.liveCockpit.actionsHint}</p></div>
      <div className="live-cockpit-actions__heading-meta">
        {staleActionKeys.size === 0 ? null : <Button className="live-cockpit-actions__retry" ariaLabel={dashboardCommonTexts().retry} size="compact" variant="secondary" onClick={retryAvailability}>{dashboardCommonTexts().retry}</Button>}
        <span className="live-cockpit-actions__count">{count}</span>
      </div>
    </header>
    <div className="live-cockpit-actions__grid" role="group" aria-label={texts.streamManager.immediateActions}>
      {modulesLoaded
        ? actions.map(({ moduleId, action }) => <ActionButton key={`${channelId}:${moduleId}:${action.id}`} action={action} moduleId={moduleId} channelId={channelId} {...(viewerUserId === undefined ? {} : { viewerUserId })} streamState={streamState} botConnected={botConnected} role={role} availabilityRetryGeneration={availabilityRetryGeneration} onAvailabilityStateChange={onAvailabilityStateChange}
          {...(onActionStart === undefined ? {} : { onActionStart })}
          {...(onActionResult === undefined ? {} : { onActionResult })}
          {...(onActionFailure === undefined ? {} : { onActionFailure })}
          {...(onFeedbackMessage === undefined ? {} : { onFeedbackMessage })} />)
        : <div className="live-cockpit-actions__loading" aria-hidden="true"><LoadStateLines rows={3} height={64} /></div>}
    </div>
  </section>;
};
