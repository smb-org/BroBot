export type TestMessageResult =
  | { result: "sent" }
  | { result: "dropped"; reason: string }
  | { result: "identity_missing" }
  | { result: "rate_limited"; retryAfter: number };

export type StreamMarkerResult =
  | { result: "created"; positionSeconds: number }
  | { result: "scope_missing"; error: "broadcast_scope_missing"; grantHref: string }
  | { result: "not_broadcaster" }
  | { result: "offline" }
  | { result: "rate_limited"; retryAfter: number }
  | { result: "token_expired" }
  | { result: "failed" };
