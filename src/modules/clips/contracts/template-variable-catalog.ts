import type { TemplateVariable } from "../../contract";

export const CLIPS_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  {
    name: "clip.title",
    group: "event",
    contexts: ["event"],
    sample: "A good moment",
    maxLength: 140,
    picker: {
      de: { label: "Clip-Titel", description: "Titel des bestätigten Clips" },
      en: { label: "Clip title", description: "Title of the confirmed clip" },
    },
  },
  {
    name: "clip.url",
    group: "event",
    contexts: ["event"],
    sample: "https://clips.twitch.tv/ClipSlug",
    maxLength: 200,
    picker: {
      de: { label: "Clip-Link", description: "Öffentlicher Link zum bestätigten Clip" },
      en: { label: "Clip link", description: "Public URL for the confirmed clip" },
    },
  },
];
