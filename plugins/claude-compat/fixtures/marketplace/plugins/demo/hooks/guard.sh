#!/bin/sh
# PreToolUse fixture: refuse any shell command that mentions forbidden-fixture-word.
input=$(cat)
case "$input" in
  *forbidden-fixture-word*)
    echo "fixture guard: forbidden-fixture-word is not allowed" >&2
    exit 2
    ;;
esac
exit 0
