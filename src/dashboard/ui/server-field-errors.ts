export type ServerFieldPathMap = Readonly<Record<string, string>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Maps one server `{ path, reason }` validation response to a known form field. */
export const mapServerFieldErrors = (
  failure: unknown,
  pathToField: ServerFieldPathMap,
): Readonly<Record<string, string>> => {
  const payload = isRecord(failure) && "details" in failure && failure.details !== null
    ? failure.details
    : failure;
  if (!isRecord(payload) || typeof payload.path !== "string" || typeof payload.reason !== "string" || payload.reason.length === 0) return {};
  const path = payload.path;
  const reason = payload.reason;
  const matchedPath = Object.prototype.hasOwnProperty.call(pathToField, path)
    ? path
    : Object.keys(pathToField)
      .filter((candidate) => path.startsWith(`${candidate}.`))
      .sort((left, right) => right.length - left.length)[0];
  if (matchedPath === undefined) return {};
  const field = pathToField[matchedPath];
  return field === undefined ? {} : { [field]: reason };
};
