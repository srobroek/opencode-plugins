#!/bin/sh
# The one executable behind every test script `writeExecutable` creates: each is a
# symlink to this file, and this runs the script body stored beside the symlink.
. "$0.body"
