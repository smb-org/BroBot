export type TestMessageResult =
  | { result: "sent" }
  | { result: "dropped"; reason: string }
  | { result: "identity_missing" }
  | { result: "rate_limited"; retryAfter: number };
