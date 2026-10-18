import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import "./member-invite-dialog.css";

import type { ChannelRole } from "../contracts/values";
import type { PanelTwitchUser } from "../panel-contract";
import { PanelApiError } from "./api";
import { roleDescription, roleLabel, membersTexts } from "./labels";
import { dashboardCommonTexts } from "./locale";
import { MemberAvatar } from "./member-avatar";
import { Button, ChoiceCards, ConfirmDialog, Field, StepDialog, registerDashboardNavigationGuard, useDraftGuard } from "./ui";

interface MemberInviteDialogProperties {
  opened: boolean;
  roles: readonly ChannelRole[];
  defaultRole: ChannelRole;
  onSearch: (login: string) => Promise<PanelTwitchUser>;
  onGrant: (userId: string, role: ChannelRole) => Promise<void>;
  errorText: (error: unknown) => string;
  onGranted: () => void;
  onAuthenticationRequired: () => void;
  onClose: () => void;
}

const INVITE_STEP_COUNT = 3;

export function MemberInviteDialog({
  opened,
  roles,
  defaultRole,
  onSearch,
  onGrant,
  errorText,
  onGranted,
  onAuthenticationRequired,
  onClose,
}: MemberInviteDialogProperties): ReactElement {
  const texts = membersTexts();
  const common = dashboardCommonTexts();
  const [step, setStep] = useState(0);
  const [login, setLogin] = useState("");
  const [found, setFound] = useState<PanelTwitchUser | null>(null);
  const [role, setRole] = useState<ChannelRole>(defaultRole);
  const [searching, setSearching] = useState(false);
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const searchGeneration = useRef(0);

  const discardDraft = (): void => {
    searchGeneration.current += 1;
    setStep(0);
    setLogin("");
    setFound(null);
    setRole(defaultRole);
    setError(undefined);
  };

  const draftDirty = opened && (login.trim().length > 0 || found !== null || step > 0);
  const draftGuard = useDraftGuard(draftDirty, () => Promise.resolve(null), discardDraft);

  useEffect(() => {
    if (!opened) return;
    return registerDashboardNavigationGuard(draftGuard.guardSwitch);
  }, [draftGuard.guardSwitch, opened]);

  const close = (): void => {
    discardDraft();
    onClose();
  };

  const requestClose = (): void => { draftGuard.guardSwitch(close); };

  const search = async (): Promise<void> => {
    const normalizedLogin = login.trim().replace(/^@/u, "");
    if (normalizedLogin.length === 0 || searching) return;
    const generation = ++searchGeneration.current;
    setSearching(true);
    setError(undefined);
    setFound(null);
    try {
      const user = await onSearch(normalizedLogin);
      if (generation !== searchGeneration.current) return;
      setFound(user);
      setRole(defaultRole);
      setStep(1);
    } catch (caught: unknown) {
      if (generation !== searchGeneration.current) return;
      setError(errorText(caught));
      if (caught instanceof PanelApiError && caught.status === 401) onAuthenticationRequired();
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  };

  const grant = async (): Promise<void> => {
    if (found === null || granting) return;
    setGranting(true);
    setError(undefined);
    try {
      await onGrant(found.userId, role);
      onGranted();
      close();
    } catch (caught: unknown) {
      setError(errorText(caught));
      if (caught instanceof PanelApiError && caught.status === 401) onAuthenticationRequired();
    } finally {
      setGranting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.tagName !== "INPUT") return;
    event.preventDefault();
    if (step === 0) void search();
    else if (step === 1) setStep(2);
  };

  const stepTitles = [texts.inviteStepPerson, texts.inviteStepRole, texts.inviteStepConfirm];
  const stepDescriptions = [texts.inviteSearchDescription, texts.inviteRoleStepDescription, texts.inviteConfirmStepDescription];
  const currentTitle = stepTitles[step] ?? texts.inviteStepPerson;
  const currentDescription = stepDescriptions[step] ?? texts.inviteSearchDescription;
  const progressLabel = texts.inviteStepCounter(step + 1, INVITE_STEP_COUNT);
  const footer = <div className="member-invite-dialog__footer">
    <div>
      <Button variant="neutral" disabled={step === 0 || searching || granting} onClick={() => { setError(undefined); setStep((current) => Math.max(0, current - 1)); }}>{texts.inviteBack}</Button>
      <Button variant="subtle" disabled={searching || granting} onClick={requestClose}>{common.cancel}</Button>
    </div>
    {step === 0 ? <Button variant="primary" disabled={login.trim().length === 0 || searching} onClick={() => { void search(); }}>{searching ? texts.searching : texts.search}</Button>
      : step === 1 ? <Button variant="primary" disabled={found === null || granting} onClick={() => { setError(undefined); setStep(2); }}>{texts.inviteNext}</Button>
        : <Button variant="primary" disabled={found === null || granting} onClick={() => { void grant(); }}>{granting ? common.saving : texts.grantPermanently}</Button>}
  </div>;

  return <>
  <StepDialog
    opened={opened}
    title={texts.grantAccessTitle}
    height={480}
    description={<div className="member-invite-dialog__intro">
      <div><h2>{currentTitle}</h2><p>{currentDescription}</p></div>
      <span>{progressLabel}</span>
      <ol aria-label={texts.inviteProgress}>
        {stepTitles.map((title, index) => <li key={title} aria-current={index === step ? "step" : undefined} data-complete={index < step ? "true" : "false"}>
          <span>{String(index + 1)}</span><span>{title}</span>
        </li>)}
      </ol>
    </div>}
    footer={footer}
    pending={searching || granting}
    onClose={requestClose}
    onKeyDown={handleKeyDown}
  >
    <div className="member-invite-dialog">
      {step === 0 ? <>
        <Field
          label={texts.twitchName}
          hint={texts.twitchNameHint}
          prefix="@"
          value={login}
          onChange={(value) => { setLogin(value); setFound(null); setError(undefined); }}
          disabled={searching}
          {...(error === undefined ? {} : { error })}
        />
        <p className="member-invite-dialog__error" role={error === undefined ? undefined : "alert"}>{error ?? "\u00a0"}</p>
      </> : found === null ? <p role="alert">{texts.changeFailed}</p> : <>
        <div className="member-invite-dialog__person">
          <MemberAvatar src={found.profileImageUrl} name={found.displayName} />
          <div><strong>{found.displayName}</strong><a href={`https://twitch.tv/${found.login}`} target="_blank" rel="noreferrer noopener">twitch.tv/{found.login}</a></div>
        </div>
        {step === 1 ? <ChoiceCards
          label={texts.role}
          hint={texts.roleHint}
          value={role}
          onChange={(next) => { setRole(next as ChannelRole); }}
          options={roles.map((candidate) => ({ value: candidate, label: roleLabel(candidate), description: roleDescription(candidate) }))}
        /> : <>
          <dl className="member-invite-dialog__summary">
            <div><dt>{texts.name}</dt><dd>{found.displayName} · @{found.login}</dd></div>
            <div><dt>{texts.role}</dt><dd>{roleLabel(role)}</dd></div>
          </dl>
          <p className="member-invite-dialog__confirmation">{texts.confirmationText(roleLabel(role))}</p>
          <p className="member-invite-dialog__error" role={error === undefined ? undefined : "alert"}>{error ?? "\u00a0"}</p>
        </>}
      </>}
    </div>
  </StepDialog>
  <ConfirmDialog
    opened={draftGuard.confirmOpen}
    title={texts.inviteUnsavedTitle}
    description={texts.inviteUnsavedDescription}
    cancelLabel={texts.continueEditing}
    confirmLabel={texts.inviteDiscard}
    danger
    onCancel={draftGuard.continueEditing}
    onConfirm={draftGuard.discardAndSwitch}
  />
  </>;
}
