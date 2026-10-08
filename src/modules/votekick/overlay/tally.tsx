import { useMemo, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { OverlayTally, OverlayTallyOptions } from "../../../overlay/tally/OverlayTally";
import { votekickOverlayLabels } from "./locale";
import { isVotekickOverlayState } from "./state";

const Tally = ({ config, state, language = "en" }: ModuleOverlayElementProps): ReactElement | null => {
  const current = useMemo(() => isVotekickOverlayState(state) ? state : null, [state]);
  const labels = votekickOverlayLabels(language);
  if (current === null) return null;

  const open = current.status === "running";
  const target = current.targetLogin ?? current.targetUserId ?? labels.unknownTarget;
  const summary = open ? labels.needed(current.threshold) : labels.outcome[current.status];
  const hideAfterCloseSeconds = typeof config.hideAfterCloseSeconds === "number" ? config.hideAfterCloseSeconds : 15;

  return <OverlayTally
    id={current.votekickId}
    title={labels.title(`@${target}`)}
    open={open}
    closesAt={current.endsAt}
    closedAt={current.endedAt}
    showCountdown={config.showCountdown !== false && open}
    hideAfterCloseSeconds={hideAfterCloseSeconds}
    countdownRemainingLabel={labels.countdownRemaining}
    summary={summary}
    className="votekick-tally"
  >
    <OverlayTallyOptions
      layout="bars"
      rows={[
        { id: "yes", label: labels.yes, count: current.yesVotes },
        { id: "no", label: labels.no, count: current.noVotes },
      ]}
    />
  </OverlayTally>;
};

export default Tally;
