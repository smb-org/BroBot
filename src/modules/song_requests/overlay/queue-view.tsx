import type { CSSProperties, ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { Icon, type IconName } from "../../../dashboard/ui/Icon";
import { songRequestQueueTexts } from "./queue-locale";
import { parseSongRequestQueueState } from "./queue-state";
import "./queue-view.css";

const SLOT_HEIGHT = 42;
const HEADER_HEIGHT = 40;

export default function SongRequestQueueOverlay({ state: rawState, language = "de" }: ModuleOverlayElementProps): ReactElement {
  const state = parseSongRequestQueueState(rawState) ?? { revision: 0, rowCount: 10, rows: [] };
  const text = songRequestQueueTexts[language];
  const slots = Array.from({ length: state.rowCount }, (_value, index) => state.rows[index] ?? null);
  return <section
    className="song-request-queue-overlay"
    style={{ width: 640, height: HEADER_HEIGHT + state.rowCount * SLOT_HEIGHT + 22, "--song-request-row-count": state.rowCount } as CSSProperties}
    aria-label={text.name}
    data-testid="song-request-queue-overlay"
    data-row-count={state.rowCount}
  >
    <h2 className="song-request-queue-overlay__title">{text.title}</h2>
    <ol className="song-request-queue-overlay__rows">
      {slots.map((row, index) => {
        if (row === null) return <li className="song-request-queue-overlay__row is-empty" aria-hidden="true" key={`empty-${String(index)}`} />;
        const requester = row.requester || (row.requestType === "vote" ? text.requesterVote : text.requesterUnknown);
        const typeLabel = row.requestType === "bot_points" ? text.typePoints
          : row.requestType === "free" ? text.typeFree
            : row.requestType === "channel_points" ? text.typeChannelPoints : text.typeVote;
        const icon: IconName = row.requestType === "bot_points" ? "coins"
          : row.requestType === "free" ? "gift"
            : row.requestType === "channel_points" ? "music" : "vote";
        return <li className="song-request-queue-overlay__row" key={`${String(index)}-${row.title}-${row.requester}`}>
          <span className="song-request-queue-overlay__index">{String(index + 1).padStart(2, "0")}</span>
          <span className="song-request-queue-overlay__type" title={typeLabel} aria-label={typeLabel}><Icon name={icon} size={20} /></span>
          <span className="song-request-queue-overlay__copy">
            <strong title={row.title}>{row.title}</strong>
            <span title={requester}>{requester}</span>
          </span>
        </li>;
      })}
    </ol>
  </section>;
}
