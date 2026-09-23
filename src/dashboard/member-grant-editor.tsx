import { useState, type ReactElement } from "react";

import type { PanelTwitchUser } from "../panel-contract";
import type { ChannelRole } from "../contracts/values";
import { PanelApiError } from "./api";
import { roleDescription, roleLabel } from "./labels";
import { dashboardCommonTexts } from "./locale";
import { Button, ChoiceCards, ConfirmDialog, EditorShell, Field } from "./ui";
import { MemberAvatar } from "./member-avatar";

export interface MemberGrantEditorTexts {
  ariaLabel: string;
  title: string;
  searchLabel: string;
  searchHint: string;
  searchButton: string;
  searchingButton: string;
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
  roles: readonly ChannelRole[];
  defaultRole: ChannelRole;
  texts: MemberGrantEditorTexts;
  onSearch: (login: string) => Promise<PanelTwitchUser>;
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
  roles,
  defaultRole,
  texts,
  onSearch,
  onGrant,
  errorText,
  onGranted,
  onAuthenticationRequired,
  onClose,
}: MemberGrantEditorProps): ReactElement {
  const common = dashboardCommonTexts();
  const [login, setLogin] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  const [found, setFound] = useState<PanelTwitchUser | null>(null);
  const [role, setRole] = useState<ChannelRole>(defaultRole);
  const [pending, setPending] = useState(false);
  const [grantError, setGrantError] = useState<string | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runSearch = async (): Promise<void> => {
    const trimmed = login.trim();
    if (searching || trimmed.length === 0) return;
    setSearching(true);
    setSearchError(undefined);
    setFound(null);
    try {
      const user = await onSearch(trimmed);
      setFound(user);
      setRole(defaultRole);
    } catch (error: unknown) {
      setSearchError(errorText(error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setSearching(false);
    }
  };

  const discard = (): void => {
    setFound(null);
    setSearchError(undefined);
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
                <Field
                  label={texts.searchLabel}
                  hint={texts.searchHint}
                  prefix="@"
                  value={login}
                  onChange={setLogin}
                  {...(searchError === undefined ? {} : { error: searchError })}
                  disabled={searching}
                  onKeyDown={(event) => { if (event.key !== "Enter") return; event.preventDefault(); void runSearch(); }}
                />
                <Button variant="neutral" disabled={searching || login.trim().length === 0} onClick={() => { void runSearch(); }}>
                  {searching ? texts.searchingButton : texts.searchButton}
                </Button>
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
        dirty={found !== null}
        pending={pending}
        {...(grantError === undefined ? {} : { error: grantError })}
        onSave={() => { if (found !== null) setConfirmOpen(true); }}
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
