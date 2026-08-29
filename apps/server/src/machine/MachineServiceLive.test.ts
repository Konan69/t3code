import { describe, expect, it } from "vite-plus/test";

import { shouldUseIncusMachineService } from "./MachineServiceLive.ts";

describe("MachineServiceLive", () => {
  it("advertises Incus only when native Linux has machine identity configured", () => {
    expect(shouldUseIncusMachineService("linux", {})).toBe(false);
    expect(
      shouldUseIncusMachineService("linux", {
        T3_MACHINE_IDENTITY_MANIFEST: "/etc/t3/machine-identity.json",
      }),
    ).toBe(true);
    expect(shouldUseIncusMachineService("win32", {})).toBe(false);
    expect(
      shouldUseIncusMachineService("linux", {
        T3_MACHINE_IDENTITY_MANIFEST: "/etc/t3/machine-identity.json",
        WSL_DISTRO_NAME: "Ubuntu-24.04",
      }),
    ).toBe(false);
    expect(
      shouldUseIncusMachineService("linux", {
        T3_MACHINE_IDENTITY_MANIFEST: "/etc/t3/machine-identity.json",
        WSL_INTEROP: "/run/WSL/1_interop",
      }),
    ).toBe(false);
  });
});
