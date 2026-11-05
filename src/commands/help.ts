import { EMULATOR_WEBHOOK_EVENTS } from "../emulator/contract";

export const COMMANDS = ["dev", "trigger", "init"] as const;

export type CommandName = (typeof COMMANDS)[number];

export function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export const MAIN_HELP = `planeward: run a Planeward community app against a local emulator

Usage
  planeward <command> [options]

Commands
  dev       Start the emulator and your app's dev server
  trigger   Send one webhook event from a running emulator
  init      Create planeward.json for the app in this folder

Options
  -h, --help     Show help (also: planeward <command> --help)
  -v, --version  Show the version
`;

export const COMMAND_HELP: Record<CommandName, string> = {
  dev: `planeward dev: start the emulator and your app

Usage
  planeward dev [options]

Reads planeward.json from this folder or the nearest parent (up to the git
root or your home folder), starts the emulator on 127.0.0.1, runs
dev.command with PLANEWARD_BASE_URL,
PLANEWARD_APP_ID, PLANEWARD_APP_SECRET and PLANEWARD_WEBHOOK_SECRET set,
and opens the emulator in your browser. A manifest from a parent folder
asks before running its dev.command (or needs --manifest without a
terminal). State lives in .planeward/ next to the manifest. Press r to reset
the state, Ctrl-C to stop.

Options
  --port <n>         Emulator port (default 4600; 0 picks a free one)
  --reset            Reseed the emulator state before starting
  --no-open          Don't open the browser
  --no-app           Don't start dev.command (run the app yourself)
  --manifest <path>  Use this planeward.json instead of searching for one
  -h, --help         Show this help
`,
  trigger: `planeward trigger: send one webhook event

Usage
  planeward trigger <event> [options]

Builds the event from the running emulator's current state (the member's
latest message, module, registration, submission or badge), sends it to the
app's webhookPath, and prints the result. Exits 1 if it wasn't delivered.

Options
  --member <id>  Member the event is about (default: the current viewer)
  --port <n>     Port of the running emulator (default 4600)
  -h, --help     Show this help

Events
${EMULATOR_WEBHOOK_EVENTS.map((event) => `  ${event}`).join("\n")}
`,
  init: `planeward init: create planeward.json

Usage
  planeward init [options]

Infers name and slug from package.json, and dev.command and dev.url from its
"dev" script (and its --port). Uses /experience, /dashboard and
/api/webhooks/planeward, and the COMMUNITY_MEMBERS_READ scope. Never
overwrites an existing planeward.json.

Options
  -y, --yes   Write without asking
  -h, --help  Show this help
`,
};
