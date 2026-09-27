import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it } from "vitest";

import { ChannelTimeZoneField } from "../../src/dashboard/ChannelTimeZoneField";

describe("channel time zone field", () => {
  afterEach(cleanup);

  it("shows the current time zone as a read-only property to operators", () => {
    render(<MantineProvider><ChannelTimeZoneField
      label="Channel time zone"
      hint="Used for date and time values."
      value="Europe/Berlin"
      onChange={() => undefined}
      canEdit={false}
      disabled={false}
    /></MantineProvider>);

    const field = screen.getByRole("textbox", { name: "Channel time zone" });
    expect(field).toHaveValue("Europe/Berlin");
    expect(field).toHaveAttribute("readonly");
    expect(field).not.toBeDisabled();
  });

  it("keeps the field editable for managers", () => {
    render(<MantineProvider><ChannelTimeZoneField
      label="Channel time zone"
      hint="Used for date and time values."
      value="Europe/Berlin"
      onChange={() => undefined}
      canEdit
      disabled={false}
    /></MantineProvider>);

    expect(screen.getByRole("textbox", { name: "Channel time zone" })).not.toHaveAttribute("readonly");
  });
});
