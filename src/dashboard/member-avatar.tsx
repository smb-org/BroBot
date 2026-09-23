import { useState, type ReactElement } from "react";

const avatarInitials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toLocaleUpperCase();

/**
 * `src` may also be missing, not just `null`: during a deploy, a new panel
 * bundle can talk to an older worker that doesn't supply the field yet.
 * A missing image must not take down the page. Shared by the members page,
 * the platform channel inspector, and `MemberGrantEditor` -- one avatar
 * rendering, not three.
 */
export function MemberAvatar({ src, name }: { src: string | null | undefined; name: string }): ReactElement {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (src === null || src === undefined || src.length === 0 || failedSource === src) {
    return <span className="member-avatar-placeholder" aria-hidden="true"><span>{avatarInitials(name)}</span></span>;
  }
  return <img className="member-avatar" src={src} alt="" aria-hidden="true" onError={() => { setFailedSource(src); }} />;
}
