export const readWranglerConfig = async (configPath) => {
  const { experimental_readRawConfig } = await import("wrangler");
  const { rawConfig } = experimental_readRawConfig({ config: configPath });
  return rawConfig;
};
