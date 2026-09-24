import { Textarea } from "@mantine/core";

interface ReadOnlyTextAreaProperties {
  id: string;
  label: string;
  value: string;
  minRows?: number;
  className?: string;
}

/** A labeled, copyable multiline value that the panel never edits. */
export function ReadOnlyTextArea({ id, label, value, minRows = 3, className }: ReadOnlyTextAreaProperties) {
  return <Textarea
    id={id}
    label={label}
    value={value}
    readOnly
    rows={minRows}
    className={className}
    styles={{ input: { fontFamily: "IBM Plex Mono, ui-monospace, monospace", fontSize: "12px" } }}
  />;
}
