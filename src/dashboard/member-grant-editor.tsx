import { useRef, useState, type ReactElement } from "react";

import type { PanelTwitchUser, PanelTwitchUserSuggestionsResponse } from "../panel-contract";
import type { ChannelRole } from "../contracts/values";
import { PanelApiError } from "./api";
import { roleDescription, roleLabel } from "./labels";
import { dashboardCommonTexts } from "./locale";
import { ChoiceCards, ConfirmDialog, EditorShell, TwitchUserField, type TwitchUserFieldHandle } from "./ui";
import { MemberAvatar } from "./member-avatar";

interface MemberGrantEditorTexts {
  ariaLabel: string;
  title: string;
  searchLabel: string;
  searchHint: string;
  roleLabel: string;
  roleHint: string;
  saveLabel: string;
  confirmTitle: (name: string) => string;
  confirmDescription: (name: string, role: string) => string;
  confirmButton: string;
  /** Only needed when `onClose` is given -- an always-visible caller (the
   *  platform channel inspector's "Add member") has no close action. */
  closeLabel?: string;
}

export interface MemberGrantEditorProps {
  channelId: string;
  roles: readonly ChannelRole[];
  defaultRole: ChannelRole;
  texts: MemberGrantEditorTexts;
  loadSuggestions?: (query: string, signal: AbortSignal) => Promise<PanelTwitchUserSuggestionsResponse>;
  onGrant: (userId: string, role: ChannelRole) => Promise<void>;
  errorText: (error: unknown) => string;
  onGranted: () => void;
  onAuthenticationRequired: () => void;
  /** Renders a close (×) button and is called after a successful grant, in
   *  addition to the editor's own reset. Omit it for an always-visible
   *  caller (nothing to close there) -- the editor still clears its search
   *  and role draft after granting either way. */
  onClose?: () => void;
}

/**
 * A "search, then confirm the found entry" flow is itself an `EditorShell`
 * (editor-konzept 15.1): the search field is the first
 * field, the result and role choice appear in the body, saving is named
 * after the action and only turns primary once a search has found someone.
 * Shared by the members page's "Grant access" and the platform channel
 * inspector's "Add member" (15.2/15b/15c) -- same role cards, same hints,
 * different search/grant calls.
 */
export function MemberGrantEditor({
  channelId,
  roles,
  defaultRole,
  texts,
  loadSuggestions,
  onGrant,
  errorText,
  onGranted,
  onAuthenticationRequired,
  onClose,
}: MemberGrantEditorProps): ReactElement {
  const common = dashboardCommonTexts();
  const [login, setLogin] = useState("");
  const [found, setFound] = useState<PanelTwitchUser | null>(null);
  const [role, setRole] = useState<ChannelRole>(defaultRole);
  const [pending, setPending] = useState(false);
  const [grantError, setGrantError] = useState<string | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const userField = useRef<TwitchUserFieldHandle>(null);

  const discard = (): void => {
    setFound(null);
    setLogin("");
    setRole(defaultRole);
    userField.current?.clear();
  };

  const handleUserChange = (user: PanelTwitchUser | null): void => {
    if (user !== null && user.userId !== found?.userId) setRole(defaultRole);
    setFound(user);
  };

  const handleLookupError = (error: unknown): void => {
    if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
  };

  const resolveForGrant = async (): Promise<void> => {
    if (resolving) return;
    setResolving(true);
    try {
      const user = await userField.current?.resolve() ?? null;
      if (user === null) return;
      setFound(user);
      setConfirmOpen(true);
    } finally {
      setResolving(false);
    }
  };

  const confirmGrant = async (): Promise<void> => {
    if (found === null) return;
    setPending(true);
    setGrantError(undefined);
    try {
      await onGrant(found.userId, role);
      setConfirmOpen(false);
      setFound(null);
      setLogin("");
      userField.current?.clear();
      setRole(defaultRole);
      onGranted();
      onClose?.();
    } catch (error: unknown) {
      setConfirmOpen(false);
      setGrantError(errorText(error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setPending(false);
    }
  };

  const roleOptions = roles.map((candidate) => ({ value: candidate, label: roleLabel(candidate), description: roleDescription(candidate) }));

  return (
    <>
      <EditorShell
        ariaLabel={texts.ariaLabel}
        title={texts.title}
        sections={[{
          id: "search",
          label: texts.title,
          content: (
            <>
              <div className="form-row">
                <TwitchUserField
                  ref={userField}
                  channelId={channelId}
                  label={texts.searchLabel}
                  hint={texts.searchHint}
                  value={found}
                  onChange={handleUserChange}
                  onLoginChange={setLogin}
                  onLookupError={handleLookupError}
                  {...(loadSuggestions === undefined ? {} : { loadSuggestions })}
                  placeholder="chatfreund"
                  disabled={resolving}
                />
              </div>
              {found === null ? null : (
                <div className="member-grant-editor__result">
                  <div className="avatar-row">
                    <MemberAvatar src={found.profileImageUrl} name={found.displayName} />
                    <div>
                      <strong>{found.displayName}</strong>
                      <a className="login-hint profile-link" href={`https://twitch.tv/${found.login}`} target="_blank" rel="noreferrer noopener">twitch.tv/{found.login}</a>
                    </div>
                  </div>
                  <ChoiceCards label={texts.roleLabel} hint={texts.roleHint} value={role} onChange={(next) => { setRole(next as ChannelRole); }} options={roleOptions} />
                </div>
              )}
            </>
          ),
        }]}
        dirty={found !== null || login.length > 0}
        pending={pending || resolving}
        {...(grantError === undefined ? {} : { error: grantError })}
        onSave={() => { void resolveForGrant(); }}
        onDiscard={discard}
        saveLabel={texts.saveLabel}
        discardLabel={common.discard}
        savedLabel={common.saved}
        pendingLabel={common.saving}
        issueLabels={{ error: common.error, warning: common.warning }}
        {...(onClose === undefined || texts.closeLabel === undefined ? {} : { onClose, closeLabel: texts.closeLabel })}
      />
      {found === null ? null : (
        <ConfirmDialog
          opened={confirmOpen}
          title={texts.confirmTitle(found.displayName)}
          description={texts.confirmDescription(found.displayName, roleLabel(role))}
          confirmLabel={texts.confirmButton}
          cancelLabel={common.cancel}
          onCancel={() => { setConfirmOpen(false); }}
          onConfirm={() => { void confirmGrant(); }}
        />
      )}
    </>
  );
}
