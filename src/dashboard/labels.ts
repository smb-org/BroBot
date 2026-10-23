import type { ChannelRole, RoleMatrixActionId } from "../contracts/values";
import { auditActionLabel as fixedAuditActionLabel, auditUnknownActionLabel, catalogString, dashboardCommonTexts, dashboardLanguage, moduleSettingsChangedText, type DashboardLanguage, type LocaleCatalog } from "./locale";
import { moduleName } from "./module-labels";

/**
 * Roles are lowercase in the data model. The UI shows the term,
 * not the enum value — the same one in both places, so the panel and the
 * member list don't drift apart.
 */
export const roleLabel = (role: ChannelRole, language: DashboardLanguage = dashboardLanguage()): string => {
  return dashboardCommonTexts(language).roles[role];
};

/** What the role is allowed to do (ADR 0006) -- the description on a role `ChoiceCards` option. */
export const roleDescription = (role: ChannelRole): string => {
  return dashboardCommonTexts().roleDescriptions[role];
};

export interface ChannelPanelTexts {
  fullConsent: string;
  fullConsentMissing: string;
  requestFullConsent: string;
  fullConsentLocked: string;
  missingBroadcasterPermissions: string;
  missingScopes: string;
}

const channelPanelCatalog: LocaleCatalog<ChannelPanelTexts> = {
  de: {
    fullConsent: "Vollzustimmung",
    fullConsentMissing: "Vollzustimmung fehlt",
    requestFullConsent: "Vollzustimmung erteilen",
    fullConsentLocked: "Nur der Broadcaster kann die Vollzustimmung erteilen.",
    missingBroadcasterPermissions: "Fehlende Broadcaster-Berechtigungen",
    missingScopes: "Fehlende Scopes",
  },
  en: {
    fullConsent: "Full consent",
    fullConsentMissing: "Full consent missing",
    requestFullConsent: "Grant full consent",
    fullConsentLocked: "Only the broadcaster can grant full consent.",
    missingBroadcasterPermissions: "Missing broadcaster permissions",
    missingScopes: "Missing scopes",
  },
};

export const channelPanelTexts = (
  language: DashboardLanguage = dashboardLanguage(),
): ChannelPanelTexts => channelPanelCatalog[language];

type PlatformAction =
  | "channel.released"
  | "channel.full_consent_changed"
  | "member.added"
  | "member.role_changed"
  | "member.removed";

export interface PlatformTexts {
  title: string;
  subtitle: (count: string) => string;
  navigation: string;
  channelOverview: string;
  channels: string;
  auditTab: string;
  login: string;
  identifier: string;
  fullConsent: string;
  fullConsentColumn: string;
  broadcaster: string;
  manager: string;
  operator: string;
  yes: string;
  no: string;
  identity: string;
  identityShort: string;
  connected: string;
  consentPending: string;
  consentPendingShort: string;
  consentPendingHint: string;
  noChannels: string;
  error: string;
  releaseChannel: string;
  twitchLogin: string;
  /** Hint under the `Field` that searches a Twitch login, for both releasing a channel and adding a member (3.0). */
  twitchLoginHint: string;
  search: string;
  searching: string;
  userFound: string;
  twitchId: (id: string) => string;
  /** Description on the full-consent switch card in "Release channel" (3.6). */
  fullConsentCardDescription: string;
  releaseChannelQuestion: (name: string) => string;
  releaseChannelDescription: (name: string, id: string, withConsent: string) => string;
  confirmRelease: string;
  invitationLink: string;
  invitationLinkHint: string;
  copyLink: string;
  linkCopied: string;
  editChannel: (name: string) => string;
  toggleConsent: string;
  members: string;
  loadMembers: string;
  noMembers: string;
  addMember: string;
  role: string;
  /** Hint under the role `ChoiceCards` when adding a member (3.0, shared with `MemberGrantEditor`). */
  roleHint: string;
  add: string;
  addMemberConfirmTitle: (name: string) => string;
  addMemberConfirmDescription: (name: string, role: string) => string;
  addMemberConfirmButton: string;
  remove: string;
  removeConfirmTitle: (name: string) => string;
  removeBroadcasterHint: string;
  removeQuestion: (name: string) => string;
  confirmRemove: (name: string) => string;
  audit: string;
  auditEmpty: string;
  timestamp: string;
  action: string;
  actor: string;
  loadMore: string;
  loadingMore: string;
  loaded: string;
  platformAdmin: string;
  member: string;
  actionLabel: Record<PlatformAction, string>;
}

const platformCatalog: LocaleCatalog<PlatformTexts> = {
  de: {
    title: "Betreiberebene",
    subtitle: (count) => `${count} Kanäle verwalten`,
    navigation: "Betreiber",
    channelOverview: "Kanalübersicht",
    channels: "Kanäle",
    auditTab: "Audit",
    login: "Login",
    identifier: "Kennung",
    fullConsent: "Vollzustimmung",
    fullConsentColumn: "Zustimmung",
    broadcaster: "Broadcaster",
    manager: "Verwalter",
    operator: "Bediener",
    yes: "Ja",
    no: "Nein",
    identity: "Broadcaster-Identität",
    identityShort: "Identität",
    connected: "Verbunden",
    consentPending: "Zustimmung ausstehend",
    consentPendingShort: "Ausstehend",
    consentPendingHint: "Vollzustimmung ist gesetzt. Der Streamer muss den Einladungslink öffnen und Twitch bestätigen.",
    noChannels: "Noch kein Kanal freigegeben.",
    error: "Die Betreiberdaten konnten nicht geladen werden.",
    releaseChannel: "Kanal freigeben",
    twitchLogin: "Twitch-Login",
    twitchLoginHint: "Genau wie auf Twitch, ohne @.",
    search: "Nutzer suchen",
    searching: "Suche läuft …",
    userFound: "Gefundener Nutzer",
    twitchId: (id) => `Twitch-ID ${id}`,
    fullConsentCardDescription: "Der Bot darf alle Funktionen mit Broadcaster-Einwilligung nutzen.",
    releaseChannelQuestion: (name) => `Kanal für ${name} freigeben?`,
    releaseChannelDescription: (name, id, withConsent) => `${name} (${id}) wird ${withConsent} Vollzustimmung angelegt.`,
    confirmRelease: "Endgültig freigeben",
    invitationLink: "Einladungslink",
    invitationLinkHint: "Diesen Link bekommt der Streamer. Er startet die Twitch-Zustimmung für den gewählten Kanal.",
    copyLink: "Link kopieren",
    linkCopied: "Link kopiert",
    editChannel: (name) => `Kanal bearbeiten: ${name}`,
    toggleConsent: "Vollzustimmung",
    members: "Mitglieder",
    loadMembers: "Mitglieder werden geladen …",
    noMembers: "Keine zusätzlichen Mitglieder freigegeben.",
    addMember: "Mitglied hinzufügen",
    role: "Rolle",
    roleHint: "Bestimmt, was diese Person im Kanal darf.",
    add: "Hinzufügen",
    addMemberConfirmTitle: (name) => `${name} hinzufügen?`,
    addMemberConfirmDescription: (name, role) => `${name} erhält Zugriff auf diesen Kanal mit der Rolle „${role}“.`,
    addMemberConfirmButton: "Endgültig hinzufügen",
    remove: "Entfernen",
    removeConfirmTitle: (name) => `Zugriff für „${name}“ entfernen?`,
    removeBroadcasterHint: "Die Broadcaster-Rolle kann der Betreiber nicht entfernen.",
    removeQuestion: (name) => `${name} verliert den Zugriff auf diesen Kanal.`,
    confirmRemove: (name) => `Mitgliedszugriff entfernen: ${name}`,
    audit: "Betreiber-Audit",
    auditEmpty: "Noch keine Betreiberhandlungen protokolliert.",
    timestamp: "Zeitpunkt",
    action: "Handlung",
    actor: "Akteur",
    loadMore: "Weitere Audit-Einträge laden",
    loadingMore: "Weitere Audit-Einträge werden geladen …",
    loaded: "geladen",
    platformAdmin: "Betreiber",
    member: "Mitglied",
    actionLabel: {
      "channel.released": "Kanal freigegeben",
      "channel.full_consent_changed": "Vollzustimmung geändert",
      "member.added": "Mitglied hinzugefügt",
      "member.role_changed": "Mitgliedsrolle geändert",
      "member.removed": "Mitglied entfernt",
    },
  },
  en: {
    title: "Operator level",
    subtitle: (count) => `Manage ${count} channels`,
    navigation: "Operator",
    channelOverview: "Channel overview",
    channels: "Channels",
    auditTab: "Audit",
    login: "Login",
    identifier: "Identifier",
    fullConsent: "Full consent",
    fullConsentColumn: "Consent",
    broadcaster: "Broadcaster",
    manager: "Manager",
    operator: "Operator",
    yes: "Yes",
    no: "No",
    identity: "Broadcaster identity",
    identityShort: "Identity",
    connected: "Connected",
    consentPending: "Consent pending",
    consentPendingShort: "Pending",
    consentPendingHint: "Full consent is set. The streamer must open the invitation link and confirm Twitch.",
    noChannels: "No channel has been released yet.",
    error: "Operator data could not be loaded.",
    releaseChannel: "Release channel",
    twitchLogin: "Twitch login",
    twitchLoginHint: "Exactly as on Twitch, without @.",
    search: "Find user",
    searching: "Searching …",
    userFound: "Found user",
    twitchId: (id) => `Twitch ID ${id}`,
    fullConsentCardDescription: "The bot may use every feature with broadcaster consent.",
    releaseChannelQuestion: (name) => `Release the channel for ${name}?`,
    releaseChannelDescription: (name, id, withConsent) => `${name} (${id}) will be created ${withConsent} full consent.`,
    confirmRelease: "Release permanently",
    invitationLink: "Invitation link",
    invitationLinkHint: "Give this link to the streamer. It starts Twitch consent for the selected channel.",
    copyLink: "Copy link",
    linkCopied: "Link copied",
    editChannel: (name) => `Edit channel: ${name}`,
    toggleConsent: "Full consent",
    members: "Members",
    loadMembers: "Loading members …",
    noMembers: "No additional members have access.",
    addMember: "Add member",
    role: "Role",
    roleHint: "Determines what this person can do in the channel.",
    add: "Add",
    addMemberConfirmTitle: (name) => `Add ${name}?`,
    addMemberConfirmDescription: (name, role) => `${name} gets access to this channel with the ${role} role.`,
    addMemberConfirmButton: "Add permanently",
    remove: "Remove",
    removeConfirmTitle: (name) => `Remove access for “${name}”?`,
    removeBroadcasterHint: "The operator cannot remove the broadcaster role.",
    removeQuestion: (name) => `${name} will lose access to this channel.`,
    confirmRemove: (name) => `Remove member access: ${name}`,
    audit: "Operator audit",
    auditEmpty: "No operator actions have been logged yet.",
    timestamp: "Time",
    action: "Action",
    actor: "Actor",
    loadMore: "Load more audit entries",
    loadingMore: "Loading more audit entries …",
    loaded: "loaded",
    platformAdmin: "Operator",
    member: "Member",
    actionLabel: {
      "channel.released": "Channel released",
      "channel.full_consent_changed": "Full consent changed",
      "member.added": "Member added",
      "member.role_changed": "Member role changed",
      "member.removed": "Member removed",
    },
  },
};

export const platformTexts = (language: DashboardLanguage = dashboardLanguage()): PlatformTexts => platformCatalog[language];

export const auditActionLabel = (
  action: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const fixedLabel = fixedAuditActionLabel(action, language);
  if (fixedLabel !== auditUnknownActionLabel(language)) return fixedLabel;

  const suffix = ".settings_changed";
  if (!action.endsWith(suffix)) return auditUnknownActionLabel(language);
  const moduleId = action.slice(0, -suffix.length);
  const name = moduleName(moduleId, language);
  if (name === moduleId) return auditUnknownActionLabel(language);
  return moduleSettingsChangedText(name, language);
};

export const platformActionLabel = (
  action: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const texts = platformCatalog[language];
  return catalogString(texts.actionLabel, action) ?? auditActionLabel(action, language);
};

export interface MembersTexts {
  managementLocked: string;
  grantAccessTitle: string;
  twitchName: string;
  /** Hint under the grant-access search `Field` (3.0). */
  twitchNameHint: string;
  search: string;
  searching: string;
  title: string;
  searchMembers: string;
  description: string;
  countSuffix: (count: number) => string;
  filteredSuffix: (count: number) => string;
  name: string;
  role: string;
  /** Hint under the role `ChoiceCards`, both when granting access and in the member inspector (3.0). */
  roleHint: string;
  accessSince: string;
  memberRowDescription: (identity: string, date: string) => string;
  editMember: (name: string) => string;
  remove: string;
  removeConfirmTitle: (name: string) => string;
  lastBroadcaster: string;
  broadcasterRoleLocked: string;
  unresolvable: string;
  twitchId: (userId: string) => string;
  roleFor: (name: string) => string;
  removeAccessFor: (name: string) => string;
  empty: string;
  confirmationText: (role: string) => string;
  grantPermanently: string;
  membersWithAccess: string;
  load: string;
  loadMore: string;
  loadingMore: string;
  loaded: string;
  sessionInvalid: string;
  changeFailed: string;
  removeSelf: string;
  removeOther: (name: string) => string;
  /** `useDraftGuard`'s three-way confirmation for an unsaved role change (2, "Entwurfsschutz"). */
  unsavedRoleTitle: string;
  unsavedRoleDescription: string;
  inviteUnsavedTitle: string;
  inviteUnsavedDescription: string;
  inviteDiscard: string;
  continueEditing: string;
  discardAndSwitch: string;
  saveAndSwitch: string;
  inviteStepPerson: string;
  inviteStepRole: string;
  inviteStepConfirm: string;
  inviteProgress: string;
  inviteStepCounter: (current: number, total: number) => string;
  inviteSearchDescription: string;
  inviteRoleStepDescription: string;
  inviteConfirmStepDescription: string;
  inviteBack: string;
  inviteNext: string;
  selectMemberPrompt: string;
  roleMatrixTitle: string;
  roleMatrixDisclosure: string;
  roleMatrixActionHeading: string;
  roleMatrixAllowed: string;
  roleMatrixDenied: string;
  roleMatrixActions: Record<RoleMatrixActionId, string>;
}

const membersCatalog: LocaleCatalog<MembersTexts> = {
  de: {
    managementLocked: "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.", grantAccessTitle: "Zugriff vergeben",
    twitchName: "Twitch-Name", twitchNameHint: "Genau wie auf Twitch, ohne @.", search: "Suchen", searching: "Suche läuft …", title: "Mitglieder", searchMembers: "Mitglieder suchen", description: "Verwalte, wer auf diesen Kanal zugreifen darf.", countSuffix: (count) => count === 1 ? "Mitglied" : "Mitglieder", filteredSuffix: (count) => count === 1 ? "Mitglied" : "Mitglieder", name: "Name",
    role: "Rolle", roleHint: "Bestimmt, was diese Person im Kanal darf.", accessSince: "Zugriff seit", memberRowDescription: (identity, date) => `${identity} · Zugriff seit ${date}`, editMember: (name) => `Mitglied bearbeiten: ${name}`, remove: "Entziehen",
    removeConfirmTitle: (name) => `Zugriff für ${name} entziehen?`,
    lastBroadcaster: "Der letzte Broadcaster kann nicht herabgestuft oder entfernt werden.", broadcasterRoleLocked: "Nur ein Broadcaster darf die Broadcaster-Rolle ändern oder entziehen.", unresolvable: "Nicht auflösbar", twitchId: (userId) => `Twitch-ID ${userId}`,
    roleFor: (name) => `Rolle für ${name}`, removeAccessFor: (name) => `Zugriff für ${name} entziehen`,
    empty: "Für diesen Kanal ist noch niemand zusätzlich freigegeben.",
    confirmationText: (role) => `Diese Person hat keinerlei Beziehung zum Kanal, die Twitch belegen würde. Mit der Rolle „${role}“ erhält sie Zugriff auf die Mitgliederliste und auf die kanalbezogenen Panel-Funktionen, die diese Rolle erlaubt.`,
    grantPermanently: "Zugriff endgültig freigeben", membersWithAccess: "Freigegebene Mitglieder",
    load: "Mitglieder werden geladen …", loadMore: "Weitere Mitglieder laden", loadingMore: "Weitere Mitglieder werden geladen …", loaded: "geladen",
    sessionInvalid: "Deine Sitzung ist nicht mehr gültig.", changeFailed: "Die Mitgliederänderung ist fehlgeschlagen.",
    removeSelf: "Du verlierst deinen Zugang und kannst nur über eine andere berechtigte Person zurückkehren.",
    removeOther: (name) => `${name} verliert den Zugang zu diesem Kanal und seinen kanalbezogenen Panel-Daten und -Funktionen.`,
    unsavedRoleTitle: "Ungespeicherte Rollenänderung",
    unsavedRoleDescription: "Die neue Rolle ist noch nicht gespeichert.",
    inviteUnsavedTitle: "Einladung verwerfen?",
    inviteUnsavedDescription: "Die Person und ihre Rolle sind noch nicht gespeichert.",
    inviteDiscard: "Verwerfen",
    continueEditing: "Weiter bearbeiten", discardAndSwitch: "Verwerfen und wechseln", saveAndSwitch: "Speichern und wechseln",
    inviteStepPerson: "Person finden", inviteStepRole: "Rolle vergeben", inviteStepConfirm: "Zugriff prüfen",
    inviteProgress: "Einladungsschritte",
    inviteStepCounter: (current, total) => `Schritt ${String(current)} von ${String(total)}`,
    inviteSearchDescription: "Gib den Twitch-Namen ohne @ ein, um das Konto zu finden.",
    inviteRoleStepDescription: "Wähle die Rolle für den Zugriff auf diesen Kanal.",
    inviteConfirmStepDescription: "Prüfe Konto und Rolle, bevor du den Zugriff freigibst.",
    inviteBack: "Zurück", inviteNext: "Weiter",
    selectMemberPrompt: "Wähle ein Mitglied aus, um den freigegebenen Zugriff und die Rolle zu prüfen.",
    roleMatrixTitle: "Berechtigungen",
    roleMatrixDisclosure: "Berechtigungen ansehen",
    roleMatrixActionHeading: "Handlung",
    roleMatrixAllowed: "Erlaubt",
    roleMatrixDenied: "Nicht erlaubt",
    roleMatrixActions: {
      view_channel: "Kanalbereiche ansehen und Protokoll lesen",
      manage_access: "Mitglieder, Module und Einstellungen verwalten",
      manage_commands: "Chatbefehle anlegen, bearbeiten und löschen",
      toggle_commands: "Einzelne Chatbefehle an- und ausschalten",
      run_voting: "Abstimmungen starten, beenden und verlängern",
      send_shoutouts_clips: "Shoutouts und Clips im Live-Cockpit auslösen",
      manage_votekicks: "Votekicks abbrechen und Timeouts aufheben",
      manage_operations: "Kanal stummschalten und Aktionen pausieren",
      adjust_counters: "Punktestände anpassen",
      manage_ads: "Werbepausen starten und verschieben",
      manage_broadcast: "Streamtitel und Kategorie ändern",
      assign_broadcaster: "Broadcaster-Rollen vergeben und entziehen",
    },
  },
  en: {
    managementLocked: "Only broadcasters and managers may change members.", grantAccessTitle: "Grant access", twitchName: "Twitch name",
    twitchNameHint: "Exactly as on Twitch, without @.", search: "Search", searching: "Searching …", title: "Members", searchMembers: "Search members", description: "Manage who can access this channel.", countSuffix: (count) => count === 1 ? "member" : "members", filteredSuffix: (count) => count === 1 ? "member" : "members", name: "Name", role: "Role",
    roleHint: "Determines what this person can do in the channel.", accessSince: "Access since", memberRowDescription: (identity, date) => `${identity} · access since ${date}`,
    editMember: (name) => `Edit member: ${name}`, remove: "Remove", removeConfirmTitle: (name) => `Remove access for ${name}?`, lastBroadcaster: "The last broadcaster cannot be demoted or removed.", broadcasterRoleLocked: "Only a broadcaster may change or remove the broadcaster role.", unresolvable: "Unresolvable",
    twitchId: (userId) => `Twitch ID ${userId}`, roleFor: (name) => `Role for ${name}`, removeAccessFor: (name) => `Remove access for ${name}`,
    empty: "No one else has access to this channel yet.",
    confirmationText: (role) => `This person has no Twitch relationship proving access to this channel. The ${role} role grants access to the member list and the channel features allowed by that role.`,
    grantPermanently: "Grant access permanently", membersWithAccess: "Members with access",
    load: "Loading members …", loadMore: "Load more members", loadingMore: "Loading more members …", loaded: "loaded",
    sessionInvalid: "Your session is no longer valid.", changeFailed: "The member change failed.",
    removeSelf: "You will lose access to this channel and can return only through another authorized person.",
    removeOther: (name) => `${name} will lose access to this channel and its channel-specific panel data and features.`,
    unsavedRoleTitle: "Unsaved role change",
    unsavedRoleDescription: "The new role has not been saved yet.",
    inviteUnsavedTitle: "Discard this invitation?",
    inviteUnsavedDescription: "The person and role have not been saved yet.",
    inviteDiscard: "Discard",
    continueEditing: "Continue editing", discardAndSwitch: "Discard and switch", saveAndSwitch: "Save and switch",
    inviteStepPerson: "Find person", inviteStepRole: "Choose role", inviteStepConfirm: "Review access",
    inviteProgress: "Invite steps",
    inviteStepCounter: (current, total) => `Step ${String(current)} of ${String(total)}`,
    inviteSearchDescription: "Enter the Twitch name without @ to find the account.",
    inviteRoleStepDescription: "Choose the role for access to this channel.",
    inviteConfirmStepDescription: "Review the account and role before granting access.",
    inviteBack: "Back", inviteNext: "Next",
    selectMemberPrompt: "Select a member to review their access and role.",
    roleMatrixTitle: "Permissions",
    roleMatrixDisclosure: "View permissions",
    roleMatrixActionHeading: "Action",
    roleMatrixAllowed: "Allowed",
    roleMatrixDenied: "Not allowed",
    roleMatrixActions: {
      view_channel: "View channel areas and read the event log",
      manage_access: "Manage members, modules, and settings",
      manage_commands: "Create, edit, and delete chat commands",
      toggle_commands: "Enable and disable individual chat commands",
      run_voting: "Start, end, and extend chat votes",
      send_shoutouts_clips: "Send shoutouts and clips from the live cockpit",
      manage_votekicks: "Cancel votekicks and lift timeouts",
      manage_operations: "Mute the channel and pause actions",
      adjust_counters: "Adjust point balances",
      manage_ads: "Start and postpone ad breaks",
      manage_broadcast: "Change the stream title and category",
      assign_broadcaster: "Grant and revoke broadcaster roles",
    },
  },
};

export const membersTexts = (language: DashboardLanguage = dashboardLanguage()): MembersTexts => membersCatalog[language];
