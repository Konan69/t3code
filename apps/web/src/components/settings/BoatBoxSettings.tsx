import { ChevronDownIcon, PlayIcon, RefreshCwIcon, ServerIcon, SquareIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  boatActionAvailability,
  boatStateTone,
  formatCredit,
  formatMachineSize,
  formatStopsIn,
  isTransitional,
  LIFETIME_OPTIONS,
  type BoatAction,
  type BoatTone,
} from "./BoatBoxSettings.logic";
import { boatBoxActions, useBoatBox } from "./boatBoxStore";
import type { DesktopBoatBox } from "@t3tools/contracts";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const TONE_DOT_CLASSNAME: Record<BoatTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/60",
};

const TONE_BADGE_VARIANT = {
  success: "success",
  warning: "warning",
  error: "error",
  neutral: "outline",
} as const satisfies Record<BoatTone, string>;

/**
 * Settings > Connections: the Boat box the agents run on. Desktop only; in the
 * web build the bridge has no Boat methods and the section does not render.
 */
export function BoatBoxSettings() {
  if (typeof window === "undefined" || window.desktopBridge?.getBoatStatus === undefined) {
    return null;
  }
  return <BoatBoxSection />;
}

function BoatBoxSection() {
  const { view, error, pending } = useBoatBox();
  // Minute-quantized clock: "stops in" stays current without per-second renders.
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  const refreshing = pending === "refresh";

  return (
    <SettingsSection
      id="boat-box"
      title="Boat box"
      icon={<ServerIcon aria-hidden className="size-4" />}
      headerAction={
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Refresh Boat box status"
          disabled={pending !== null}
          onClick={boatBoxActions.refresh}
        >
          {refreshing ? <Spinner size="sm" /> : <RefreshCwIcon aria-hidden className="size-3.5" />}
        </Button>
      }
    >
      {view.kind === "loading" ? <LoadingRow /> : null}
      {view.kind === "notConfigured" ? <NotConfiguredRow missing={view.missing} /> : null}
      {view.kind === "notFound" ? (
        <SettingsRow
          title="Box not found"
          description={`No Boat box named “${view.name}” exists on this account. Check CLOUDBOX_BOAT_NAME, then restart T3.`}
        />
      ) : null}
      {view.kind === "unreachable" ? (
        <SettingsRow
          title="Can’t reach Boat"
          description={error ?? "The request to Boat did not complete."}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={boatBoxActions.refresh}
            >
              {refreshing ? <Spinner size="sm" /> : null}
              Retry
            </Button>
          }
        />
      ) : null}
      {view.kind === "box" ? (
        <BoxRows box={view.box} nowMs={nowMs} pending={pending} error={error} />
      ) : null}
    </SettingsSection>
  );
}

/** Same two-line height as the real box row, so the data arriving does not shift the page. */
function LoadingRow() {
  return (
    <SettingsRow
      title={<span className="text-muted-foreground">Checking Boat box…</span>}
      description={<Skeleton className="mt-1 h-3 w-44" />}
    />
  );
}

function NotConfiguredRow({ missing }: { readonly missing: ReadonlyArray<string> }) {
  return (
    <SettingsRow
      title="Boat isn’t set up"
      description={
        <>
          Missing{" "}
          {missing.map((name, index) => (
            <span key={name}>
              {index > 0 ? " and " : ""}
              <code className="font-mono">{name}</code>
            </span>
          ))}
          . Set {missing.length === 1 ? "it" : "them"} as Windows user environment variables, then
          restart T3.
        </>
      }
    />
  );
}

function BoxRows({
  box,
  nowMs,
  pending,
  error,
}: {
  readonly box: DesktopBoatBox;
  readonly nowMs: number;
  readonly pending: BoatAction | null;
  readonly error: string | null;
}) {
  const { label, tone } = boatStateTone(box.state);
  const actions = boatActionAvailability(box.state, pending);
  const machine = formatMachineSize(box);
  const credit = formatCredit(box.creditBalanceHours);
  const transitional = isTransitional(box.state);
  const running = box.state === "running";

  return (
    <>
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            {box.name}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant={TONE_BADGE_VARIANT[tone]} className="cursor-default">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 rounded-full",
                        TONE_DOT_CLASSNAME[tone],
                        transitional && "motion-safe:animate-pulse",
                      )}
                    />
                    {label}
                  </Badge>
                }
              />
              <TooltipPopup side="top">Boat reports: {box.rawState}</TooltipPopup>
            </Tooltip>
          </span>
        }
        description={
          [
            machine,
            box.state === "stopped" ? "Also starts by itself when you open a thread on it." : null,
            box.state === "error" ? `Boat reports: ${box.rawState}` : null,
          ]
            .filter((line): line is string => line !== null)
            .join(" · ") || undefined
        }
        control={
          running ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!actions.canStop}
              onClick={boatBoxActions.stop}
            >
              {pending === "stop" ? <Spinner size="sm" /> : <SquareIcon aria-hidden />}
              {pending === "stop" ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button size="sm" disabled={!actions.canStart} onClick={boatBoxActions.start}>
              {pending === "start" || box.state === "starting" ? (
                <Spinner size="sm" />
              ) : (
                <PlayIcon aria-hidden />
              )}
              {pending === "start" || box.state === "starting" ? "Starting…" : "Start"}
            </Button>
          )
        }
      />
      {running ? (
        <SettingsRow
          title={formatStopsIn(box.stopsAt, nowMs)}
          description={credit ?? undefined}
          control={
            <Menu>
              <MenuTrigger
                render={
                  <Button size="sm" variant="outline" disabled={!actions.canSetLifetime}>
                    {pending === "lifetime" ? <Spinner size="sm" /> : null}
                    Keep on for
                    <ChevronDownIcon aria-hidden />
                  </Button>
                }
              />
              <MenuPopup align="end">
                {LIFETIME_OPTIONS.map((option) => (
                  <MenuItem
                    key={option.label}
                    onClick={() => boatBoxActions.setLifetime(option.ttlSeconds)}
                  >
                    {option.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          }
        />
      ) : credit !== null ? (
        <SettingsRow title="Credit" description={credit} />
      ) : null}
      {error !== null ? (
        <div className="px-3 py-3 sm:px-4">
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={boatBoxActions.refresh}
              >
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}
    </>
  );
}
