import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelTimeZoneField } from "../../src/dashboard/ChannelTimeZoneField";

describe("channel time zone field", () => {
  afterEach(cleanup);

  it("shows the current time zone as a read-only select to operators", () => {
    render(<MantineProvider><ChannelTimeZoneField
      label="Channel time zone"
      hint="Used for date and time values."
      value="Europe/Berlin"
      onChange={() => undefined}
      canEdit={false}
      disabled={false}
    /></MantineProvider>);

    const field = screen.getByRole("combobox", { name: "Channel time zone" });
    expect(field).toHaveValue("Europe/Berlin");
    expect(field).toBeDisabled();
  });

  it("lets managers search and select IANA time zones", async () => {
    const onChange = vi.fn();
    render(<MantineProvider><ChannelTimeZoneField
      label="Channel time zone"
      hint="Used for date and time values."
      value="Europe/Berlin"
      onChange={onChange}
      canEdit
      disabled={false}
    /></MantineProvider>);

    const field = screen.getByRole("combobox", { name: "Channel time zone" });
    expect(field).not.toBeDisabled();
    fireEvent.click(field);
    fireEvent.change(field, { target: { value: "America/New_York" } });
    fireEvent.click(await screen.findByRole("option", { name: "America/New_York" }));
    expect(onChange).toHaveBeenCalledWith("America/New_York");
  });
});
