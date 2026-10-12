import { describe, expect, it } from "vitest";

import { textBlockWriteGuard } from "../../src/modules/contracts/text-block-write-guard";

describe("text block write guard", () => {
  it("keeps D1 bindings bounded when a consumer references many blocks", () => {
    const references = Array.from({ length: 50 }, (_, index) => `block_${String(index)}`);
    const guard = textBlockWriteGuard("channel-a", 7, references.map((name) => `{text.${name}}`));

    expect(guard.references).toEqual(references);
    expect(guard.values).toHaveLength(4);
    expect(guard.values).toEqual(["channel-a", 7, JSON.stringify(references), "channel-a"]);
    expect(guard.sql.match(/json_each\(/gu)).toHaveLength(1);
  });
});
