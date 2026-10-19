import { renderTemplate } from "../../contract";
import type { ClipsSettings } from "../contracts";
import { CLIPS_TEMPLATE_VARIABLES } from "../contracts";

export interface ConfirmedClipTemplateValues {
  title: string;
  url: string;
}

export const configuredClipLinkMessage = (
  settings: Pick<ClipsSettings, "postClipLinkInChat" | "chatLinkTemplate">,
  clip: ConfirmedClipTemplateValues | null,
): string | null => {
  if (!settings.postClipLinkInChat || clip === null) return null;
  const message = renderTemplate(settings.chatLinkTemplate, {
    "clip.title": clip.title,
    "clip.url": clip.url,
  }, {}, CLIPS_TEMPLATE_VARIABLES);
  return message.trim().length === 0 ? null : message;
};
