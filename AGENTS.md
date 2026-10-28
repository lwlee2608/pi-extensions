# AGENTS.md

Browser e2e on Linux: if Chrome aborts with "No usable sandbox", ask the user to run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (resets on reboot).
