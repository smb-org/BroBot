import type { ModuleDiagnostic, ModuleTemplateRenderMode } from "../../contract";

export const renderOverlayTextPreservingDynamicValues = async (
  source: string,
  dynamicNames: ReadonlySet<string>,
  renderTemplate: (text: string, mode?: ModuleTemplateRenderMode) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[]; attributions?: readonly string[] }>,
): Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[]; dynamicNames: readonly string[]; attributions?: readonly string[] }> => {
  const preserved: string[] = [];
  const masked = source.replace(/\{([a-z][a-z0-9_.]{0,63})\}/gu, (token, name: string) => {
    if (!dynamicNames.has(name)) return token;
    const index = preserved.push(token) - 1;
    return `\uE000${String(index)}\uE001`;
  });
  const rendered = await renderTemplate(masked, "overlay");
  let text = rendered.text;
  preserved.forEach((token, index) => {
    text = text.replaceAll(`\uE000${String(index)}\uE001`, token);
  });
  return {
    text,
    diagnostics: rendered.diagnostics,
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
    dynamicNames: [...new Set([...source.matchAll(/\{([a-z][a-z0-9_.]{0,63})\}/gu)]
      .flatMap((match) => match[1] !== undefined && dynamicNames.has(match[1]) ? [match[1]] : []))],
  };
};
