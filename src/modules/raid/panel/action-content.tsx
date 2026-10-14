import { useState, type ReactElement } from "react";

import { Field } from "../../../dashboard/ui";
import type { ModuleImmediateActionContentProperties } from "../../contract";
import { raidActionContentTexts } from "./action-content-locale";

export default function ShoutoutActionContent({ language }: ModuleImmediateActionContentProperties): ReactElement {
  const [login, setLogin] = useState("");

  return <div className="live-action-content">
    <Field
      name="login"
      label={raidActionContentTexts.channelName[language]}
      hint={raidActionContentTexts.channelHint[language]}
      prefix="@"
      value={login}
      onChange={setLogin}
      required
      autoComplete="off"
      placeholder={raidActionContentTexts.channelRequired[language]}
    />
  </div>;
}
