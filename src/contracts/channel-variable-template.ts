const CHANNEL_VARIABLE_TEMPLATE_NAME_SOURCE = "[a-z][a-z0-9_]{0,31}";
const CHANNEL_VARIABLE_TEMPLATE_SOURCE = `\\{var\\.(${CHANNEL_VARIABLE_TEMPLATE_NAME_SOURCE})\\}`;

export const channelVariableTemplateToken = (name: string): string => `{var.${name}}`;

export const channelVariableTemplateNames = (text: string): string[] => {
  const expression = new RegExp(CHANNEL_VARIABLE_TEMPLATE_SOURCE, "gu");
  return [...new Set([...text.matchAll(expression)].flatMap((match) => match[1] === undefined ? [] : [match[1]]))];
};

export const replaceChannelVariableTemplateToken = (text: string, from: string, to: string): string =>
  text.replaceAll(channelVariableTemplateToken(from), channelVariableTemplateToken(to));
