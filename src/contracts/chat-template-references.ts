import { TEMPLATE_VARIABLE_PATTERN } from "../template";

export interface ChatTemplateReferenceDiagnostic {
  code: "template.chat_reference_dropped";
  detail: { name: string };
}

const chatReferencePrefixes = ["var.", "text.", "api."] as const;

export const omitUnresolvedChatTemplateReferences = (text: string): { text: string; diagnostics: ChatTemplateReferenceDiagnostic[] } => {
  const droppedNames = new Set<string>();
  const safeText = text.replace(TEMPLATE_VARIABLE_PATTERN, (token, name: string) => {
    if (!chatReferencePrefixes.some((prefix) => name.startsWith(prefix))) return token;
    droppedNames.add(name);
    return "";
  });
  return {
    text: safeText,
    diagnostics: [...droppedNames].map((name) => ({
      code: "template.chat_reference_dropped",
      detail: { name },
    })),
  };
};
