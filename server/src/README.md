# @peershell/server (Stage 5)

Placeholder. The rendezvous + blind relay + reverse HTTP tunnel + accounts/dashboard server is
implemented in Stage 5 (deployed on the user's Proxmox behind a cloudflared tunnel). It consumes
`@peershell/protocol` and must implement the contract in `../../PROTOCOL.md`.

A throwaway ~120-line Node `ws`+`http` relay (per the plan's verification section) is the precursor
used to smoke-test the clients before this is built.
