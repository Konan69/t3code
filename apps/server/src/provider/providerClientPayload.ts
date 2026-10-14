import type { ServerProvider } from "@t3tools/contracts";

// Composer menus show one line per skill or command, but a provider status
// repeats every skill and command description once for the provider and once
// per workspace snapshot. With a few hundred skills that is megabytes per
// connect and per status change, which a phone on a slow uplink cannot load
// before its connection setup times out. The agents keep the full text; only
// what clients receive is shortened.
export const CLIENT_DESCRIPTION_MAX_LENGTH = 160;

const shorten = (text: string): string =>
  text.length <= CLIENT_DESCRIPTION_MAX_LENGTH
    ? text
    : `${text.slice(0, CLIENT_DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`;

const shortenDescription = <T extends { readonly description?: string | undefined }>(
  entry: T,
): T =>
  entry.description === undefined || entry.description.length <= CLIENT_DESCRIPTION_MAX_LENGTH
    ? entry
    : { ...entry, description: shorten(entry.description) };

const compactSkills = (skills: ServerProvider["skills"]): ServerProvider["skills"] =>
  skills.map((skill) => {
    const shortened = shortenDescription(skill);
    return skill.shortDescription === undefined ||
      skill.shortDescription.length <= CLIENT_DESCRIPTION_MAX_LENGTH
      ? shortened
      : { ...shortened, shortDescription: shorten(skill.shortDescription) };
  });

const compactSlashCommands = (
  commands: ServerProvider["slashCommands"],
): ServerProvider["slashCommands"] => commands.map(shortenDescription);

export const compactProviderForClient = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  skills: compactSkills(provider.skills),
  slashCommands: compactSlashCommands(provider.slashCommands),
  ...(provider.workspaceSnapshots !== undefined
    ? {
        workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
          ...snapshot,
          skills: compactSkills(snapshot.skills),
          slashCommands: compactSlashCommands(snapshot.slashCommands),
        })),
      }
    : {}),
});

export const compactProvidersForClient = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> => providers.map(compactProviderForClient);
