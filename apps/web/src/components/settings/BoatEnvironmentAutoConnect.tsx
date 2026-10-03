import * as Option from "effect/Option";
import { useEffect, useRef } from "react";

import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/**
 * Registers the configured Boat box as a T3 environment at startup, with no
 * user action. A box that only appears in Settings cannot run a thread; it has
 * to be an SSH environment, and the owner asked for that to be set up for him
 * rather than offered as a button.
 *
 * Runs once per app start, after the saved environments have loaded (so an
 * already-registered box is never registered twice), and only when the box
 * exists on the Boat account. The box's Boat name is its SSH alias. Connecting
 * resumes a stopped box through the SSH proxy, which is the intended wake.
 * Failures are reported once as a toast; the Settings row offers the retry.
 */
export function BoatEnvironmentAutoConnect() {
  const { environments, isReady } = useEnvironments();
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, { reportFailure: false });
  const attempted = useRef(false);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (attempted.current || !isReady || bridge?.getBoatStatus === undefined) return;
    attempted.current = true;

    void (async () => {
      const status = await bridge.getBoatStatus?.();
      if (status === undefined || status._tag !== "Box") return;
      const alias = status.box.name;
      const alreadyRegistered = environments.some((environment) => {
        const profile = environment.entry.profile;
        return (
          environment.entry.target._tag === "SshConnectionTarget" &&
          Option.isSome(profile) &&
          profile.value._tag === "SshConnectionProfile" &&
          profile.value.target.alias === alias
        );
      });
      if (alreadyRegistered) return;
      try {
        const target = await bridge.resolveSshHost(alias);
        const result = await connectSshEnvironment({ target, label: "Boat box" });
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Boat box is not connected",
            description: "Open Settings, Connections to see why and retry.",
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: "Boat box connected",
          description: `${alias} is now an environment you can switch to.`,
        });
      } catch {
        toastManager.add({
          type: "error",
          title: "Boat box is not connected",
          description: "Open Settings, Connections to see why and retry.",
        });
      }
    })();
  }, [connectSshEnvironment, environments, isReady]);

  return null;
}
