import type { ChannelRole } from "../contracts/values";
import { dashboardCommonTexts, dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "./locale";

/**
 * Roles are lowercase in the data model. The UI shows the term,
 * not the enum value — the same one in both places, so the panel and the
 * member list don't drift apart.
 */
export const roleLabel = (role: ChannelRole): string => {
  return dashboardCommonTexts().roles[role];
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
  broadcaster: string;
  manager: string;
  operator: string;
  yes: string;
  no: string;
  identity: string;
  connected: string;
  consentPending: string;
  consentPendingHint: string;
  load: string;
  noChannels: string;
  error: string;
  releaseChannel: string;
  twitchLogin: string;
  search: string;
  searching: string;
  userFound: string;
  twitchId: (id: string) => string;
  setFullConsent: string;
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
  newRole: string;
  add: string;
  change: string;
  remove: string;
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
    broadcaster: "Broadcaster",
    manager: "Verwalter",
    operator: "Bediener",
    yes: "Ja",
    no: "Nein",
    identity: "Broadcaster-Identität",
    connected: "Verbunden",
    consentPending: "Zustimmung ausstehend",
    consentPendingHint: "Vollzustimmung ist gesetzt. Der Streamer muss den Einladungslink öffnen und Twitch bestätigen.",
    load: "Betreiberdaten werden geladen …",
    noChannels: "Noch kein Kanal freigegeben.",
    error: "Die Betreiberdaten konnten nicht geladen werden.",
    releaseChannel: "Kanal freigeben",
    twitchLogin: "Twitch-Login",
    search: "Nutzer suchen",
    searching: "Suche läuft …",
    userFound: "Gefundener Nutzer",
    twitchId: (id) => `Twitch-ID ${id}`,
    setFullConsent: "Vollzustimmung setzen",
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
    newRole: "Rolle für neue Mitgliedschaft",
    add: "Hinzufügen",
    change: "Ändern",
    remove: "Entfernen",
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
    broadcaster: "Broadcaster",
    manager: "Manager",
    operator: "Operator",
    yes: "Yes",
    no: "No",
    identity: "Broadcaster identity",
    connected: "Connected",
    consentPending: "Consent pending",
    consentPendingHint: "Full consent is set. The streamer must open the invitation link and confirm Twitch.",
    load: "Loading operator data …",
    noChannels: "No channel has been released yet.",
    error: "Operator data could not be loaded.",
    releaseChannel: "Release channel",
    twitchLogin: "Twitch login",
    search: "Find user",
    searching: "Searching …",
    userFound: "Found user",
    twitchId: (id) => `Twitch ID ${id}`,
    setFullConsent: "Set full consent",
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
    newRole: "Role for new membership",
    add: "Add",
    change: "Change",
    remove: "Remove",
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

export const platformActionLabel = (
  action: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const texts = platformCatalog[language];
  return Object.prototype.hasOwnProperty.call(texts.actionLabel, action)
    ? texts.actionLabel[action as PlatformAction]
    : action;
};
