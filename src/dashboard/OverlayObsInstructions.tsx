import type { ReactElement } from "react";

import { overlayObsInstructionsTexts } from "./locale";

export const OBS_OVERLAY_CSS_EXAMPLE = `.brobot-variable {
  font: 700 48px system-ui, sans-serif;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .9);
}`;

export function OverlayObsInstructions(): ReactElement {
  const labels = overlayObsInstructionsTexts();
  return <details className="overlay-obs-instructions">
    <summary>{labels.summary}</summary>
    <div className="overlay-obs-instructions__content">
      <ol>
        <li>{labels.addBrowserSource}</li>
        <li>{labels.sourceSize}</li>
      </ol>
      <ul>
        <li>{labels.refreshWhenActive}</li>
        <li>{labels.shutdownWhenHidden}</li>
      </ul>
      <p>{labels.customCss}</p>
      <pre><code>{OBS_OVERLAY_CSS_EXAMPLE}</code></pre>
      <p>{labels.secret}</p>
    </div>
  </details>;
}
