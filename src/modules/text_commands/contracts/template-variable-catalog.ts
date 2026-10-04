import type { ModuleTemplateVariableGroup } from "../../contract";
import type { TemplateVariable } from "../contract";

const icon = { paths: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z", "M12 7v10", "M8.5 10.5h7", "M8.5 13.5h5"] } as const;

export const TEXT_COMMAND_TEMPLATE_VARIABLE_GROUP: ModuleTemplateVariableGroup = {
  label: { de: "Textbefehle", en: "Text commands" },
  icon,
  order: 60,
};

export const TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  {
    name: "timeout.seconds",
    group: "command",
    contexts: ["chat_command"],
    sample: "120",
    maxLength: 7,
    picker: {
      de: { label: "Timeout-Dauer in Sekunden", description: "Die Dauer des Timeout-Befehls als Sekundenwert.", sample: "120" },
      en: { label: "Timeout duration in seconds", description: "The timeout duration as a number of seconds.", sample: "120" },
    },
  },
  {
    name: "timeout.duration",
    group: "command",
    contexts: ["chat_command"],
    sample: "2 Min. 30 s",
    maxLength: 27,
    picker: {
      de: { label: "Timeout-Dauer", description: "Die Timeout-Dauer in lesbarer Form.", sample: "2 Min. 30 s" },
      en: { label: "Timeout duration", description: "The timeout duration in a readable format.", sample: "2 min 30 s" },
    },
  },
];
