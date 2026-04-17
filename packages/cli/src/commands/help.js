/**
 * help — list all available CLI commands
 */
export function helpCommand() {
  console.log(`
opencode-telegram — OpenCode Telegram CLI

USAGE
  opencode-telegram [command] [options]

COMMANDS

  Telegram bot
    start, dev          Start the Telegram bot (default)
    attach [url]        Attach terminal to an OpenCode session
    kill-all            Stop all OpenCode server instances

  Projects
    projects list       List all projects and their running status

  Sessions
    session list <path>       List sessions for a project
    session switch <path> <id> Switch to a session
    session new <path>         Create a new session

  Interaction
    send <prompt> [--project <path>]   Send a prompt, print the reply
    stop [--project <path>]            Abort current execution

  Agent mode
    mode <name> [--project <path>]    Set agent mode
    mode list [--project <path>]      List available modes

  Utility
    help                        Show this help text

EXAMPLES
  opencode-telegram projects list
  opencode-telegram session new /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram send "fix the login bug" --project /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram stop --project /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram mode agent --project /Users/petartopic/Desktop/Profico/web-app

PROJECT ROOTS
  Personal:  /Users/petartopic/Desktop/Petar
  Work:      /Users/petartopic/Desktop/Profico
`);
}
