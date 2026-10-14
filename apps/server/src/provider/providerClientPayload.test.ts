import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  CLIENT_DESCRIPTION_MAX_LENGTH,
  compactProviderForClient,
} from "./providerClientPayload.ts";

const long = "word ".repeat(200).trim();

const skill = (name: string, description: string) => ({
  name,
  description,
  path: `/home/user/.claude/skills/${name}/SKILL.md`,
  enabled: true,
});

describe("compactProviderForClient", () => {
  it("shortens long skill and command descriptions everywhere a client receives them", () => {
    const provider = {
      skills: [skill("long", long), skill("short", "Does one thing.")],
      slashCommands: [{ name: "long", description: long }],
      workspaceSnapshots: [
        {
          cwd: "/repo",
          checkedAt: "2026-10-14T16:00:00.000Z",
          skills: [skill("long", long)],
          slashCommands: [{ name: "long", description: long }],
        },
      ],
    } as unknown as ServerProvider;

    const compacted = compactProviderForClient(provider);
    const descriptions = [
      compacted.skills[0]?.description,
      compacted.slashCommands[0]?.description,
      compacted.workspaceSnapshots?.[0]?.skills[0]?.description,
      compacted.workspaceSnapshots?.[0]?.slashCommands[0]?.description,
    ];
    for (const description of descriptions) {
      expect(description?.length).toBeLessThanOrEqual(CLIENT_DESCRIPTION_MAX_LENGTH);
      expect(description?.endsWith("…")).toBe(true);
      expect(long.startsWith(description!.slice(0, -1))).toBe(true);
    }
    expect(compacted.skills[1]).toBe(provider.skills[1]);
    expect(compacted.skills[0]?.path).toBe(provider.skills[0]?.path);
  });
});
