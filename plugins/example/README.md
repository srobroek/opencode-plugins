# example

Reference OpenCode V2 plugin. It shows the two patterns most plugins in this
repository use:

- `ctx.tool.transform` adds a tool (`example_echo`).
- `ctx.tool.hook("execute.before")` blocks a tool call by throwing. Here it
  refuses `git push --force` without `--force-with-lease`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/example'
```
