import type { ChannelRole } from "../contracts/values";
import { auditActionLabel as fixedAuditActionLabel, catalogString, dashboardCommonTexts, dashboardLanguage, moduleSettingsChangedText, type DashboardLanguage, type LocaleCatalog } from "./locale";
import { moduleName } from "./module-labels";

/**
 * Roles are lowercase in the data model. The UI shows the term,
 * not the enum value — the same one in both places, so the panel and the
 * member list don't drift apart.
 */
export const roleLabel = (role: ChannelRole): string => {
  return dashboardCommonTexts().roles[role];
};

/** What the role is allowed to do (ADR 0006) -- the description on a role `ChoiceCards` option. */
export const roleDescription = (role: ChannelRole): string => {
  return dashboardCommonTexts().roleDescriptions[role];
};

export interface ChannelPanelTexts {
  fullConsentMissing: string;
  requestFullConsent: string;
  fullConsentLocked: string;
  missingBroadcasterPermissions: string;
  missingScopes: string;
}

const channelPanelCatalog: LocaleCatalog<ChannelPanelTexts> = {
  de: {
    fullConsentMissing: "Vollzustimmung fehlt",
    requestFullConsent: "Vollzustimmung erteilen",
    fullConsentLocked: "Nur der Broadcaster kann die Vollzustimmung erteilen.",
    missingBroadcasterPermissions: "Fehlende Broadcaster-Berechtigungen",
    missingScopes: "Fehlende Scopes",
  },
  en: {
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

export type PlatformAction =
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
  load: string;
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
  setFullConsent: string;
  /** Description on the full-consent switch card in "Release channel" (3.6). */
  fullConsentCardDescription: string;
  releaseChannelQuestion: (name: string) => string;
  releaseChannelDescription: (name: string, id: string, withConsent: string) => string;
  confirmRelease: string;
  invitationLink: string;
  invitationLinkHint: string;
  selectChannel: string;
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
  newRole: string;
  add: string;
  addMemberConfirmTitle: (name: string) => string;
  addMemberConfirmDescription: (name: string, role: string) => string;
  addMemberConfirmButton: string;
  change: string;
  remove: string;
  removeConfirmTitle: (name: string) => string;
  removeBroadcasterHint: string;
  removeQuestion: (name: string) => string;
  confirmRemove: string;
  audit: string;
  loadAudit: string;
  auditEmpty: string;
  timestamp: string;
  action: string;
  actor: string;
  loadMore: string;
  loadingMore: string;
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
    load: "Betreiberdaten werden geladen …",
    noChannels: "Noch kein Kanal freigegeben.",
    error: "Die Betreiberdaten konnten nicht geladen werden.",
    releaseChannel: "Kanal freigeben",
    twitchLogin: "Twitch-Login",
    twitchLoginHint: "Genau wie auf Twitch, ohne @.",
    search: "Nutzer suchen",
    searching: "Suche läuft …",
    userFound: "Gefundener Nutzer",
    twitchId: (id) => `Twitch-ID ${id}`,
    setFullConsent: "Vollzustimmung setzen",
    fullConsentCardDescription: "Der Bot darf alle Funktionen mit Broadcaster-Einwilligung nutzen.",
    releaseChannelQuestion: (name) => `Kanal für ${name} freigeben?`,
    releaseChannelDescription: (name, id, withConsent) => `${name} (${id}) wird ${withConsent} Vollzustimmung angelegt.`,
    confirmRelease: "Endgültig freigeben",
    invitationLink: "Einladungslink",
    invitationLinkHint: "Diesen Link bekommt der Streamer. Er startet die Twitch-Zustimmung für den gewählten Kanal.",
    selectChannel: "Wähle zuerst eine Kanalzeile.",
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
    newRole: "Rolle für neue Mitgliedschaft",
    add: "Hinzufügen",
    addMemberConfirmTitle: (name) => `${name} hinzufügen?`,
    addMemberConfirmDescription: (name, role) => `${name} erhält Zugriff auf diesen Kanal mit der Rolle „${role}“.`,
    addMemberConfirmButton: "Endgültig hinzufügen",
    change: "Ändern",
    remove: "Entfernen",
    removeConfirmTitle: (name) => `Zugriff für ${name} entfernen?`,
    removeBroadcasterHint: "Die Broadcaster-Rolle kann der Betreiber nicht entfernen.",
    removeQuestion: (name) => `Zugriff für ${name} wirklich entfernen?`,
    confirmRemove: "Endgültig entfernen",
    audit: "Betreiber-Audit",
    loadAudit: "Audit wird geladen …",
    auditEmpty: "Noch keine Betreiberhandlungen protokolliert.",
    timestamp: "Zeitpunkt",
    action: "Handlung",
    actor: "Akteur",
    loadMore: "Weitere Audit-Einträge laden",
    loadingMore: "Weitere Audit-Einträge werden geladen …",
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
    load: "Loading operator data …",
    noChannels: "No channel has been released yet.",
    error: "Operator data could not be loaded.",
    releaseChannel: "Release channel",
    twitchLogin: "Twitch login",
    twitchLoginHint: "Exactly as on Twitch, without @.",
    search: "Find user",
    searching: "Searching …",
    userFound: "Found user",
    twitchId: (id) => `Twitch ID ${id}`,
    setFullConsent: "Set full consent",
    fullConsentCardDescription: "The bot may use every feature with broadcaster consent.",
    releaseChannelQuestion: (name) => `Release the channel for ${name}?`,
    releaseChannelDescription: (name, id, withConsent) => `${name} (${id}) will be created ${withConsent} full consent.`,
    confirmRelease: "Release permanently",
    invitationLink: "Invitation link",
    invitationLinkHint: "Give this link to the streamer. It starts Twitch consent for the selected channel.",
    selectChannel: "Select a channel row first.",
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
    newRole: "Role for new membership",
    add: "Add",
    addMemberConfirmTitle: (name) => `Add ${name}?`,
    addMemberConfirmDescription: (name, role) => `${name} gets access to this channel with the ${role} role.`,
    addMemberConfirmButton: "Add permanently",
    change: "Change",
    remove: "Remove",
    removeConfirmTitle: (name) => `Remove access for ${name}?`,
    removeBroadcasterHint: "The operator cannot remove the broadcaster role.",
    removeQuestion: (name) => `Remove access for ${name}?`,
    confirmRemove: "Remove permanently",
    audit: "Operator audit",
    loadAudit: "Loading audit …",
    auditEmpty: "No operator actions have been logged yet.",
    timestamp: "Time",
    action: "Action",
    actor: "Actor",
    loadMore: "Load more audit entries",
    loadingMore: "Loading more audit entries …",
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
  if (fixedLabel !== action) return fixedLabel;

  const suffix = ".settings_changed";
  if (!action.endsWith(suffix)) return action;
  const moduleId = action.slice(0, -suffix.length);
  const name = moduleName(moduleId, language);
  if (name === moduleId) return action;
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
  count: (count: string) => string;
  name: string;
  role: string;
  /** Hint under the role `ChoiceCards`, both when granting access and in the member inspector (3.0). */
  roleHint: string;
  accessSince: string;
  editMember: (name: string) => string;
  remove: string;
  removeConfirmTitle: (name: string) => string;
  lastBroadcaster: string;
  unresolvable: string;
  twitchId: (userId: string) => string;
  roleFor: (name: string) => string;
  removeAccessFor: (name: string) => string;
  empty: string;
  grantAccess: string;
  newMemberRoleLabel: string;
  confirmationTitle: (name: string) => string;
  confirmationText: (role: string) => string;
  grantPermanently: string;
  membersWithAccess: string;
  load: string;
  loadMore: string;
  loadingMore: string;
  sessionInvalid: string;
  changeFailed: string;
  removeSelf: string;
  removeOther: (name: string) => string;
  /** `useDraftGuard`'s three-way confirmation for an unsaved role change (2, "Entwurfsschutz"). */
  unsavedRoleTitle: string;
  unsavedRoleDescription: string;
  continueEditing: string;
  discardAndSwitch: string;
  saveAndSwitch: string;
}

const membersCatalog: LocaleCatalog<MembersTexts> = {
  de: {
    managementLocked: "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.", grantAccessTitle: "Zugriff vergeben",
    twitchName: "Twitch-Name", twitchNameHint: "Genau wie auf Twitch, ohne @.", search: "Suchen", searching: "Suche läuft …", title: "Mitglieder", count: (count) => `${count} Mitglieder`, name: "Name",
    role: "Rolle", roleHint: "Bestimmt, was diese Person im Kanal darf.", accessSince: "Zugriff seit", editMember: (name) => `Mitglied bearbeiten: ${name}`, remove: "Entziehen",
    removeConfirmTitle: (name) => `Zugriff für ${name} entziehen?`,
    lastBroadcaster: "Letzter Broadcaster", unresolvable: "Nicht auflösbar", twitchId: (userId) => `Twitch-ID ${userId}`,
    roleFor: (name) => `Rolle für ${name}`, removeAccessFor: (name) => `Zugriff für ${name} entziehen`,
    empty: "Für diesen Kanal ist noch niemand zusätzlich freigegeben.", grantAccess: "Zugriff freigeben",
    newMemberRoleLabel: "Rolle für neue Mitgliedschaft", confirmationTitle: (name) => `Zugriff für ${name} freigeben?`,
    confirmationText: (role) => `Diese Person hat keinerlei Beziehung zum Kanal, die Twitch belegen würde. Mit der Rolle „${role}“ erhält sie Zugriff auf die Mitgliederliste und auf die kanalbezogenen Panel-Funktionen, die diese Rolle erlaubt.`,
    grantPermanently: "Zugriff endgültig freigeben", membersWithAccess: "Freigegebene Mitglieder",
    load: "Mitglieder werden geladen …", loadMore: "Weitere Mitglieder laden", loadingMore: "Weitere Mitglieder werden geladen …",
    sessionInvalid: "Deine Sitzung ist nicht mehr gültig.", changeFailed: "Die Mitgliederänderung ist fehlgeschlagen.",
    removeSelf: "Deinen eigenen Zugang zu diesem Kanal wirklich entziehen? Du sperrst dich damit selbst aus und kommst nur über eine andere berechtigte Person zurück.",
    removeOther: (name) => `Zugriff für ${name} wirklich entziehen? Die Person verliert den Zugang zu diesem Kanal und allen kanalbezogenen Panel-Daten und -Funktionen.`,
    unsavedRoleTitle: "Ungespeicherte Rollenänderung",
    unsavedRoleDescription: "Die neue Rolle ist noch nicht gespeichert.",
    continueEditing: "Weiter bearbeiten", discardAndSwitch: "Verwerfen und wechseln", saveAndSwitch: "Speichern und wechseln",
  },
  en: {
    managementLocked: "Only broadcasters and managers may change members.", grantAccessTitle: "Grant access", twitchName: "Twitch name",
    twitchNameHint: "Exactly as on Twitch, without @.", search: "Search", searching: "Searching …", title: "Members", count: (count) => `${count} members`, name: "Name", role: "Role",
    roleHint: "Determines what this person can do in the channel.", accessSince: "Access since",
    editMember: (name) => `Edit member: ${name}`, remove: "Remove", removeConfirmTitle: (name) => `Remove access for ${name}?`, lastBroadcaster: "Last broadcaster", unresolvable: "Unresolvable",
    twitchId: (userId) => `Twitch ID ${userId}`, roleFor: (name) => `Role for ${name}`, removeAccessFor: (name) => `Remove access for ${name}`,
    empty: "No one else has access to this channel yet.", grantAccess: "Grant access", newMemberRoleLabel: "Role for new membership",
    confirmationTitle: (name) => `Grant access for ${name}?`, confirmationText: (role) => `This person has no Twitch relationship proving access to this channel. The ${role} role grants access to the member list and the channel features allowed by that role.`,
    grantPermanently: "Grant access permanently", membersWithAccess: "Members with access",
    load: "Loading members …", loadMore: "Load more members", loadingMore: "Loading more members …",
    sessionInvalid: "Your session is no longer valid.", changeFailed: "The member change failed.",
    removeSelf: "Remove your own access to this channel? This locks you out and you can return only through another authorized person.",
    removeOther: (name) => `Remove access for ${name}? This person will lose access to this channel and all channel-specific panel data and features.`,
    unsavedRoleTitle: "Unsaved role change",
    unsavedRoleDescription: "The new role has not been saved yet.",
    continueEditing: "Continue editing", discardAndSwitch: "Discard and switch", saveAndSwitch: "Save and switch",
  },
};

export const membersTexts = (language: DashboardLanguage = dashboardLanguage()): MembersTexts => membersCatalog[language];
