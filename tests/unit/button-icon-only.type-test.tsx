import type { ButtonProps } from "../../src/dashboard/ui/Button";

// @ts-expect-error icon-only buttons require an accessible ariaLabel
const missingAccessibleName: ButtonProps = { icon: "close", iconOnly: true };

void missingAccessibleName;
