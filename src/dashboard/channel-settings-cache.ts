import type { PanelChannelSettings } from "./api";

export const mergeChannelSettingsResponse = (
  current: PanelChannelSettings,
  update: Partial<PanelChannelSettings>,
): PanelChannelSettings => {
  const merged = { ...current, ...update };
  if (update.revision !== undefined && update.revision < current.revision) {
    merged.timeZone = current.timeZone;
    merged.revision = current.revision;
  }
  if (update.locationRevision !== undefined && update.locationRevision < current.locationRevision) {
    merged.location = current.location;
    merged.locationRevision = current.locationRevision;
  }
  if (update.defaultChatTargetRevision !== undefined && update.defaultChatTargetRevision < current.defaultChatTargetRevision) {
    merged.defaultChatTarget = current.defaultChatTarget;
    merged.defaultChatTargetRevision = current.defaultChatTargetRevision;
  }
  return merged;
};
