/**
 * help — list all available CLI commands
 */
export function helpCommand() {
  console.log(`
opencode-telegram — OpenCode Telegram CLI

USAGE
  opencode-telegram [command] [options]

START MODES
  opencode-telegram serve [--port 4097]  HTTP API server (for cloudflared tunnel)
  opencode-telegram start bot      Start Telegram bot only
  opencode-telegram start cli      Start interactive CLI REPL only
  opencode-telegram start all      Start both bot and CLI (default)
  opencode-telegram bot            Shortcut for 'start bot'
  opencode-telegram cli            Shortcut for 'start cli'
  opencode-telegram                Shortcut for 'start all'

COMMANDS

  Projects
    projects list               List all projects and their running status
    project start [path]       Start OpenCode server instance (defaults to cwd)
    project stop [path]          Stop OpenCode server instance (defaults to cwd)
    project list                List running instances

  Sessions
    session list <path>         List sessions for a project
    session switch <path> <id>  Switch to a session
    session new <path>          Create a new session

  Interaction
    send <prompt> [--project <path>]   Send a prompt, print the reply
    stop [--project <path>]            Abort current execution

  Agent mode
    mode list [--project <path>]       List available modes
    mode <name> [--project <path>]   Set agent mode

  Model config
    model list                          Show current SMART/NORMAL model assignments
    model set smarter [model-id]        Pick or set the SMART model (agents: sisyphus, oracle, metis, momus, prometheus, hephaestus)
    model set normal [model-id]         Pick or set the NORMAL model (agents: explore, librarian, atlas, sisyphus-junior, etc.)
    model smarter [model-id]            Shortcut for 'model set smarter'
    model normal [model-id]             Shortcut for 'model set normal'

  Code Search
    code-index <path> [--watch]     Index a project (start server on port 4098 first)
    code-search <query> [--limit 10]  Search indexed code
    code-status                       Show index statistics

  Lifecycle
    status              Show all running instances and their health
    logs <path>         Tail logs for a project
    watch <path>        Stream session messages (Ctrl+C to stop)
    kill-all            Stop all OpenCode server instances

  Utility
    help              Show this help text

EXAMPLES
  opencode-telegram                    # start bot + CLI
  opencode-telegram bot                # bot only
  opencode-telegram cli                # interactive REPL
  opencode-telegram projects list
  opencode-telegram session new /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram send "fix the login bug" --project /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram stop --project /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram mode agent --project /Users/petartopic/Desktop/Profico/web-app
  opencode-telegram watch /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram project start
  opencode-telegram project start /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram project stop /Users/petartopic/Desktop/Petar/my-project
  opencode-telegram watch /Users/petartopic/Desktop/Petar/my-project --interval=1000
  opencode-telegram kill-all

PROJECT ROOTS
  Personal:  /Users/petartopic/Desktop/Petar
  Work:      /Users/petartopic/Desktop/Profico
`);
}
