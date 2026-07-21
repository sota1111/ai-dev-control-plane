# Remote SSH + Git Clone Verification

A record of verifying that a remote host is reachable over SSH and can `git clone` a
target repository. This is an operational connectivity check — it confirms the host,
authentication, and outbound `git` access work end to end before relying on the host
for real work.

## Verified target

| Item | Value |
| --- | --- |
| Host | `192.168.10.10` |
| User | `morohashisouta` |
| Remote OS | macOS (Apple Git 2.39.3) |
| Repository | `https://github.com/sota1111/cloud-nomad-agent` |
| Auth | ED25519 public-key (`~/.ssh/id_ed25519`) |
| Result | ✅ SSH login OK, `git clone` exit `0`, `main` branch fetched |

## Procedure

### 1. Register the host key (first connection)

```bash
ssh -o StrictHostKeyChecking=accept-new morohashisouta@192.168.10.10 'whoami'
```

The host's ED25519 key is added to `~/.ssh/known_hosts`.

### 2. Set up key-based authentication

Generate a key pair (if none exists) and register the public key on the remote:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
ssh-copy-id -i ~/.ssh/id_ed25519.pub morohashisouta@192.168.10.10
```

Alternatively, append the public key to the remote's `~/.ssh/authorized_keys` manually
(`chmod 700 ~/.ssh`, `chmod 600 ~/.ssh/authorized_keys`).

### 3. Verify the connection

```bash
ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 morohashisouta@192.168.10.10 \
  'echo CONNECTED; whoami; git --version'
```

`BatchMode=yes` guarantees the check fails fast (non-zero exit) instead of hanging on a
password prompt when key auth is not yet configured.

### 4. Verify `git clone`

```bash
ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 morohashisouta@192.168.10.10 \
  'git clone https://github.com/sota1111/cloud-nomad-agent /tmp/cna-clone-test; echo "EXIT=$?"'
```

`EXIT=0` confirms the clone succeeded. The verification clone under `/tmp` was removed
after inspecting the `main` branch and repository layout; no permanent working copy was
left on the host.

## Troubleshooting

- `Host key verification failed` — the host key is not yet trusted. Re-run step 1 with
  `-o StrictHostKeyChecking=accept-new`.
- `Permission denied (publickey,password,keyboard-interactive)` — no usable credential.
  Complete step 2 (register a public key) or supply a password interactively.
