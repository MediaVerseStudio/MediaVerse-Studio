// With the Jellyfin server alone as the library (D173) the commands that read the music folder are answered from the server instead, and any other command that
// names a song of the server needs a file and is refused with a plain message. Pure, so it is unit tested; `desktop-bridge.ts` applies it to every command.

export type ServerHandler = (args: Record<string, unknown>) => Promise<unknown>;
export type ServerHandlerSet = Record<string, ServerHandler>;

/** The commands whose lists hold songs of the server (favorites, playlists, flags, history): they go to the program as usual. */
const SONG_LIST_COMMANDS = new Set(["record_play", "set_favorite", "set_flag", "save_playlist"]);

export const NEEDS_FOLDER = {
  code: "needs_folder",
  message: "That needs your music in a folder (on this computer, or the Jellyfin server's shared folder). With the Jellyfin server alone as the library, this program plays and casts songs.",
};

export function namesServerSong(args: Record<string, unknown> | undefined): boolean {
  const named = (value: unknown): boolean => typeof value === "string" && value.startsWith("jellyfin:");
  return named(args?.path) || (Array.isArray(args?.paths) && args.paths.some(named));
}

/** `{answer}` when the server library answers the command; null when it goes to the program; throws `NEEDS_FOLDER` for a command that needs the file of a song of the server. */
export async function routeServerCommand(handlers: ServerHandlerSet | null, command: string, args: Record<string, unknown> | undefined): Promise<{ answer: unknown } | null> {
  if (!handlers) return null;
  const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined;
  if (handler) return { answer: await handler(args ?? {}) };
  if (!SONG_LIST_COMMANDS.has(command) && namesServerSong(args)) throw NEEDS_FOLDER;
  return null;
}
