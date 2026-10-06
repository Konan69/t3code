import { OtlpHeadersFromString, OtlpProtocol } from "@t3tools/shared/observability";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.Boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  t3Home: trimmedString("T3CODE_HOME"),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("T3CODE_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteT3ServerEntryPath: trimmedString("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.Port("T3CODE_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("T3CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("T3CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("T3CODE_DESKTOP_HTTPS_ENDPOINTS"),
  cloudboxWakeEndpoint: trimmedString("CLOUDBOX_WAKE_URL"),
  cloudboxWakeName: trimmedString("CLOUDBOX_WAKE_NAME"),
  cloudboxWakeSecret: trimmedString("CLOUDBOX_WAKE_SECRET"),
  cloudboxWakeEnvironmentId: trimmedString("CLOUDBOX_WAKE_ENVIRONMENT_ID"),
  boatApiKey: Config.Redacted("BOAT_API_KEY").pipe(
    Config.option,
    Config.map(
      Option.flatMap((key) =>
        trimNonEmptyOption(Redacted.value(key)).pipe(Option.map(Redacted.make)),
      ),
    ),
  ),
  cloudboxBoatName: trimmedString("CLOUDBOX_BOAT_NAME"),
  cloudboxBoatTtlSeconds: Config.Int("CLOUDBOX_BOAT_TTL_SECONDS").pipe(Config.withDefault(7200)),
  otlpTracesUrl: trimmedString("T3CODE_OTLP_TRACES_URL"),
  otlpMetricsUrl: trimmedString("T3CODE_OTLP_METRICS_URL"),
  otlpLogsUrl: trimmedString("T3CODE_OTLP_LOGS_URL"),
  otlpExportIntervalMs: Config.Int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "T3CODE_OTLP_HEADERS").pipe(Config.option),
  otlpProtocol: Config.schema(OtlpProtocol, "T3CODE_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("T3CODE_DISABLE_AUTO_UPDATE"),
  // Fork: where the local build pipeline publishes its status (see
  // updates/LocalStagedUpdate.ts). Defaults to a file under %LOCALAPPDATA%.
  localUpdateStatusPath: trimmedString("T3CODE_LOCAL_UPDATE_STATUS_PATH"),
  localAppData: trimmedString("LOCALAPPDATA"),
  mockUpdates: optionalBoolean("T3CODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.Port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
