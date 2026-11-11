import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadTitlePrompt } from "./textGenerationPrompts.ts";

const choice = {
  folders: [
    { name: "Jobs", recentTitles: ["Interview prep"] },
    { name: "Personal", recentTitles: [] },
  ],
};

const offered = buildThreadTitlePrompt({ message: "Prep for my onsite", folderChoice: choice });
const decodeOffered = Schema.decodeUnknownSync(offered.outputSchema);
const plain = buildThreadTitlePrompt({ message: "Prep for my onsite" });
const decodePlain = Schema.decodeSync(plain.outputSchema);

describe("thread title prompt with a folder choice", () => {
  it("asks for a folder only when one is offered, and a missing answer reads as none", () => {
    expect(offered.prompt).toContain('- "Jobs": "Interview prep"\n- "Personal"');
    const decode = decodeOffered;
    expect(decode({ title: "Onsite prep", folder: "Jobs" })).toEqual({
      title: "Onsite prep",
      needsRefinement: false,
      folder: "Jobs",
    });
    expect(decode({ title: "Onsite prep" })).toEqual({
      title: "Onsite prep",
      needsRefinement: false,
      folder: null,
    });

    expect(plain.prompt).not.toContain("Folders");
    expect(decodePlain({ title: "Onsite prep" })).toEqual({
      title: "Onsite prep",
      needsRefinement: false,
    });
  });
});
