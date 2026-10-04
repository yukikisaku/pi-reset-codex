# pi-reset-codex

## Overview

Use an earned Codex reset credit from inside Pi.

## Requirements

Requires the `codex` CLI, an authenticated Codex account, and an account with reset-credit support. The extension starts `codex app-server` locally and calls its rate-limit reset methods.

## Installation

```sh
pi install npm:@yukikisaku/pi-reset-codex
```

## Usage

Run `/reset-codex`. Pi shows current weekly usage and available reset credits before asking for confirmation. Confirming consumes one earned reset credit, changes the Codex weekly usage limit state, and reduces the available reset-credit count by one. The extension does not provide an undo action. After the reset, Pi refreshes the displayed usage and remaining credits.

## Configuration

Set `CODEX_BIN` if the Codex executable is not named `codex`.

## Uninstallation

```sh
pi uninstall npm:@yukikisaku/pi-reset-codex
```

Remove any package-specific configuration described above if you no longer need it.

## Pull requests

This repository includes a policy for automatic AI review and merge of incoming pull requests. It becomes active when the CI and merge workflows are on `main` and the maintainer's GitHub event automation is enabled; a draft setup PR does not activate it.

Once active, AI reviews each non-draft PR and it is merged automatically only when the review has no findings, required CI succeeds, and there are no conflicts or unresolved review threads. New commits require a new review. Changes to the automation itself require manual merge. See [AI review and merge operations](docs/ai-review-operations.md).

## License

MIT © yuki-kisaku. See [LICENSE](LICENSE).
