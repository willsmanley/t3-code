import { describe, expect, it } from "vite-plus/test";

import { resolveGroupPanel } from "./legacySidebarFolders.logic";

describe("resolveGroupPanel", () => {
  const keys = ["a", "b", "c", "d", "e"];

  it("shows the preview plus the open thread, and everything after Show more", () => {
    expect(
      resolveGroupPanel({ keys, expanded: true, showAll: false, previewCount: 2, activeKey: "d" }),
    ).toEqual({ rendered: ["a", "b", "d"], hidden: ["c", "e"], hasOverflow: true });
    expect(
      resolveGroupPanel({ keys, expanded: true, showAll: true, previewCount: 2, activeKey: "d" }),
    ).toEqual({ rendered: keys, hidden: [], hasOverflow: true });
  });

  it("does not count the open thread alone as overflow", () => {
    expect(
      resolveGroupPanel({
        keys: ["a", "b", "c"],
        expanded: true,
        showAll: false,
        previewCount: 2,
        activeKey: "c",
      }),
    ).toEqual({ rendered: ["a", "b", "c"], hidden: [], hasOverflow: false });
  });

  it("keeps only the open thread in a collapsed folder", () => {
    expect(
      resolveGroupPanel({ keys, expanded: false, showAll: false, previewCount: 2, activeKey: "e" }),
    ).toEqual({ rendered: ["e"], hidden: [], hasOverflow: false });
    expect(
      resolveGroupPanel({ keys, expanded: false, showAll: true, previewCount: 2, activeKey: "z" }),
    ).toEqual({ rendered: [], hidden: [], hasOverflow: false });
  });
});
