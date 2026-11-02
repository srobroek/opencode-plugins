#!/bin/sh
# PostToolUse fixture: tell the model which file was read, through additionalContext.
input=$(cat)
file=$(printf '%s' "$input" | sed -n 's/.*"file_path":"\([^"]*\)".*/\1/p')
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"fixture after-read saw %s"}}' "$file"
