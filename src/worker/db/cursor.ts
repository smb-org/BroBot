export const encodeCursor = (cursor: unknown): string => {
  const serialized = JSON.stringify(cursor);
  const encoded = btoa(serialized);
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

export const decodeCursor = <T>(
  serialized: string,
  mapValue: (value: unknown) => T | null,
): T | null => {
  try {
    const normalized = serialized.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(serialized.length / 4) * 4, "=");
    return mapValue(JSON.parse(atob(normalized)));
  } catch {
    return null;
  }
};
