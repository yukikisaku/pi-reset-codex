# pi-codex-reset

## Overview

Use an earned Codex reset credit from inside Pi.

## Requirements

Requires the `codex` CLI, an authenticated Codex account, and an account with reset-credit support. The extension starts `codex app-server` locally and calls its rate-limit reset methods.

## Installation

```sh
pi install npm:@yukikisaku/pi-codex-reset
```

## Usage

Run `/reset-codex`. Pi shows current weekly usage and available reset credits before asking for confirmation. Confirming consumes one earned reset credit, changes the Codex weekly usage limit state, and reduces the available reset-credit count by one. The extension does not provide an undo action. After the reset, Pi refreshes the displayed usage and remaining credits.

## Configuration

Set `CODEX_BIN` if the Codex executable is not named `codex`.

## Uninstallation

```sh
pi uninstall npm:@yukikisaku/pi-codex-reset
```

Remove any package-specific configuration described above if you no longer need it.

## License

MIT © yuki-kisaku. See [LICENSE](LICENSE).
