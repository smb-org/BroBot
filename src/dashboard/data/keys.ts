export type ChannelQueryParams = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type ChannelQueryKey = readonly ["channel", string, string, ...ChannelQueryParams[]];

export const queryKeys = {
  channel: (channelId: string, resource: string, ...params: ChannelQueryParams[]): ChannelQueryKey => [
    "channel",
    channelId,
    resource,
    ...params,
  ],
};

export const isChannelQueryKey = (queryKey: readonly unknown[]): queryKey is ChannelQueryKey =>
  queryKey[0] === "channel" &&
  typeof queryKey[1] === "string" &&
  typeof queryKey[2] === "string" &&
  queryKey.slice(3).every((value) => typeof value === "object" && value !== null && !Array.isArray(value));
