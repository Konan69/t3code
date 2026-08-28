import { describe, expect, it } from "vite-plus/test";

import { shouldUseIncusMachineService } from "./MachineServiceLive.ts";

describe("MachineServiceLive", () => {
  it("selects Incus only on native Linux and keeps Windows and WSL host-local", () => {
    expect(shouldUseIncusMachineService("linux", {})).toBe(true);
    expect(shouldUseIncusMachineService("win32", {})).toBe(false);
    expect(shouldUseIncusMachineService("linux", { WSL_DISTRO_NAME: "Ubuntu-24.04" })).toBe(false);
    expect(shouldUseIncusMachineService("linux", { WSL_INTEROP: "/run/WSL/1_interop" })).toBe(
      false,
    );
  });
});
