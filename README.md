# Pocket Forge

[![make.fun git forge bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/chikaasl/pocket-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![Reward](https://make.fun/badge/github-core-clone-01/chikaasl/pocket-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Pocket Forge is a single-process, in-memory Git host for the make.fun forge
bounty. Smart HTTP and the REST, GraphQL, and MCP operations share the same
repositories, Git objects, issues, and pull requests.

Run it in the supplied make.fun harness with Node 22.

```sh
node main.ts
```

The harness supplies `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`. The process
registers its assigned TCP port with the harness and exits when the trial ends.
GraphQL supports a subset of repository, issue, and pull request operations.
