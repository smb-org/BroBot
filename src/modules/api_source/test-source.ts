import type { ApiSourceFailureReason, ApiSourceTestResult } from "./contracts";
import type { ModuleExternalFetchBudget } from "../contract";
import { fetchUncachedApiSourceJson, ApiSourceFetchError } from "./adapters/fetch-json";
import { evaluateApiSourceExpression, formatApiSourceValue, inspectApiSourceExpression } from "./domain";
import { isValidApiSourceUrl } from "./domain/url";

export const testApiSource = async (
  db: D1Database,
  channelId: string,
  externalFetchBudget: ModuleExternalFetchBudget,
  url: string,
  expression: string,
  ownOrigin: string | undefined,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<ApiSourceTestResult> => {
  if (!isValidApiSourceUrl(url, ownOrigin)) return { status: "error", reason: "invalid_url" };
  const expressionError = inspectApiSourceExpression(expression);
  if (expressionError?.kind === "construct_not_allowed") {
    return { status: "error", reason: "unsupported_expression", constructName: expressionError.constructName };
  }
  if (expressionError !== null) return { status: "error", reason: "invalid_expression" };

  let response: Awaited<ReturnType<typeof fetchUncachedApiSourceJson>>;
  try {
    response = await fetchUncachedApiSourceJson(db, channelId, url, ownOrigin, now, externalFetchBudget, fetcher);
  } catch (failure: unknown) {
    if (failure instanceof ApiSourceFetchError) {
      return {
        status: "error",
        reason: failure.reason,
        ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }),
      };
    }
    return { status: "error", reason: "unreachable" };
  }

  let value: unknown;
  try {
    value = await evaluateApiSourceExpression(expression, response.payload);
  } catch {
    return { status: "error", reason: "invalid_expression", httpStatus: response.httpStatus };
  }
  if (value === undefined || value === null) {
    return { status: "error", reason: "missing_value", httpStatus: response.httpStatus };
  }

  try {
    return {
      status: "ok",
      httpStatus: response.httpStatus,
      bytes: response.bytes,
      json: response.payload,
      value: formatApiSourceValue(value),
    };
  } catch {
    const reason: ApiSourceFailureReason = "invalid_expression";
    return { status: "error", reason, httpStatus: response.httpStatus };
  }
};
