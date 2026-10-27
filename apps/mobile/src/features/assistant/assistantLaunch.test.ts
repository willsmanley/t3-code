import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "../../lib/appLinking";
import { assistantDraftParams, isAssistantLaunchUrl } from "./assistantLaunch";

const personal = {
  environmentId: EnvironmentId.make("env-1"),
  id: ProjectId.make("project-personal"),
  workspaceRoot: "/home/user/personal",
};
const school = {
  environmentId: EnvironmentId.make("env-1"),
  id: ProjectId.make("project-school"),
  workspaceRoot: "/home/user/personal/school",
};

describe("isAssistantLaunchUrl", () => {
  it.each(["t3code://assist", "t3code-preview://assist", "t3code-dev://assist/"])(
    "matches %s",
    (url) => {
      expect(isAssistantLaunchUrl(url)).toBe(true);
      // The hook handles it, so the router must not open NotFound for it.
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );

  it.each(["t3code://new", "t3code://assistant", "https://example.com/assist"])(
    "ignores %s",
    (url) => {
      expect(isAssistantLaunchUrl(url)).toBe(false);
    },
  );
});

describe("assistantDraftParams", () => {
  it("opens a draft in the project at the configured folder", () => {
    expect(assistantDraftParams([school, personal], "/home/user/personal/", "launch-1")).toEqual({
      requestId: "launch-1",
      environmentId: "env-1",
      projectId: "project-personal",
    });
  });

  it("returns null without a configured folder or a matching project", () => {
    expect(assistantDraftParams([personal], null, "launch-1")).toBeNull();
    expect(assistantDraftParams([school], "/home/user/personal", "launch-1")).toBeNull();
  });
});
