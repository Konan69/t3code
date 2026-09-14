import { describe, expect, it } from "@effect/vitest";

import { decryptHostLifecycleSecret, encryptHostLifecycleSecret } from "./HostLifecycleCrypto.ts";

describe("host lifecycle secret encryption", () => {
  it("round-trips without storing the bearer secret in plaintext", async () => {
    const ciphertext = await encryptHostLifecycleSecret({
      keyMaterial: "relay-private-key-material",
      environmentId: "env-1",
      secret: "wake-secret",
    });

    expect(ciphertext).not.toContain("wake-secret");
    await expect(
      decryptHostLifecycleSecret({
        keyMaterial: "relay-private-key-material",
        environmentId: "env-1",
        ciphertext,
      }),
    ).resolves.toBe("wake-secret");
  });

  it("binds ciphertext to the environment id", async () => {
    const ciphertext = await encryptHostLifecycleSecret({
      keyMaterial: "relay-private-key-material",
      environmentId: "env-1",
      secret: "wake-secret",
    });

    await expect(
      decryptHostLifecycleSecret({
        keyMaterial: "relay-private-key-material",
        environmentId: "env-2",
        ciphertext,
      }),
    ).rejects.toThrow();
  });
});
