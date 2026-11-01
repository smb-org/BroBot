import { PanelApiError } from "../../../contracts/panel-error";

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
};

const isAmbiguousFailure = (error: unknown): boolean =>
  !(error instanceof PanelApiError) || error.status === 408 || error.status === 429 || error.status >= 500;

interface Submission {
  signature: string;
  operationId: string;
}

export const createTempVipSubmissionTracker = (
  createOperationId: () => string = () => crypto.randomUUID(),
) => {
  const pending = new Map<string, Submission>();

  return {
    async submit<Result>(
      key: string,
      payload: unknown,
      send: (operationId: string) => Promise<Result>,
    ): Promise<Result> {
      const signature = canonicalJson(payload);
      const current = pending.get(key);
      const operationId = current?.signature === signature ? current.operationId : createOperationId();
      pending.set(key, { signature, operationId });
      try {
        const result = await send(operationId);
        if (pending.get(key)?.operationId === operationId) pending.delete(key);
        return result;
      } catch (error) {
        if (!isAmbiguousFailure(error) && pending.get(key)?.operationId === operationId) pending.delete(key);
        throw error;
      }
    },
  };
};
