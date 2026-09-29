# Running on another machine

Ostoyae runs wherever you can open a shell: a Linux VM, a cloud box, a machine on your
Tailscale network, or WSL. The runner, the agents and the board live on that machine. Your
laptop is only a window into it.

## 1. Install it

One command over SSH:

```sh
ssh you@box 'curl -fsSL https://raw.githubusercontent.com/teal-sea/ostoyae/main/install.sh | bash'
```

The installer needs no sudo. If Node.js 22+, Git, Bash or Python 3 is missing it stops, prints
the install command for that system, and installs nothing. It puts Ostoyae in `~/.ostoyae` and
links `~/.local/bin/ostoyae`. If `~/.local/bin` is not on the remote PATH it prints the line to
add. Until you add it, call `~/.local/bin/ostoyae`.

To install a copy you already have instead of fetching one, copy the checkout over and point the
installer at it:

```sh
rsync -a --exclude .git ./Ostoyae/ you@box:Ostoyae/
ssh you@box 'OSTOYAE_SOURCE=$HOME/Ostoyae bash $HOME/Ostoyae/install.sh'
```

Re-run either command to upgrade. `bash ~/.ostoyae/install.sh --uninstall` removes the install
and the link. It leaves boards, `ost/*` branches, worktrees and `~/.local/state/ostoyae` alone.

## 2. Log the agent in, with no browser on the box

Install the agent CLI on the box by following its own install page. Then log it in. The cell an
agent runs in keeps only `PATH`, `HOME`, `USER`, `SHELL` and `TMPDIR` from your environment. A
login saved in a file under your home directory works as is. **A token in an environment variable
reaches the agent only if the board names it**, with `ostoyae init --env NAME`.

**Claude Code.** Source: [code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication), read 2026-09-27.

- Run `claude` in an SSH session. It prints a login URL. Open it on your laptop. When the browser
  shows a code instead of returning, paste the code into the terminal. The docs name SSH
  sessions as a case where this happens. On Linux the login is saved in
  `~/.claude/.credentials.json`, so cells find it through `HOME`.
- Or, on any machine with a browser, run `claude setup-token`. It prints a one-year token for a
  Pro, Max, Team or Enterprise subscription and saves it nowhere. On the box, set it as
  `CLAUDE_CODE_OAUTH_TOKEN` and pass it through:
  `ostoyae init --agent claude --env CLAUDE_CODE_OAUTH_TOKEN --item "..."`.
- Or use a Console API key in `ANTHROPIC_API_KEY`, passed the same way with `--env ANTHROPIC_API_KEY`.

**Codex.** Source: [developers.openai.com/codex/auth](https://developers.openai.com/codex/auth)
(served from learn.chatgpt.com/docs/auth), read 2026-09-27.

- `codex login --device-auth`, then open the printed link on your laptop and enter the code.
- Or `printenv OPENAI_API_KEY | codex login --with-api-key`.
- Or copy the cached login from your laptop:
  `ssh you@box 'mkdir -p ~/.codex && cat > ~/.codex/auth.json' < ~/.codex/auth.json`.
  The docs say to treat that file like a password.

Other adapters are listed in [executors](executors.md). Whatever you use, `ostoyae doctor`
checks the saved login the same way a cell will see it, without sending a model prompt.

## 3. Run a board there

```sh
ssh you@box
cd your-repo
ostoyae init --agent claude --profile headless --item "Fix add() in calc.py" --check "python3 -m pytest -q"
ostoyae doctor
ostoyae dry
ostoyae go --invocations 3 --headless
ostoyae land
```

An SSH disconnect can end a run in the foreground. Start it inside `tmux` or
`screen` if the box has one. `ostoyae stop` asks a run to stop launching and let current work
finish.

The finished work is on the board's trunk branch, `ost/<graph>/trunk`, until you take it. The end
of the run prints the branch and the command. `ostoyae land` fast-forwards your base branch and
refuses anything that would need a merge commit, printing the `git merge` command instead.

## 4. Watch it from your laptop

**In a terminal.** `ssh -t you@box 'cd your-repo && ~/.local/bin/ostoyae watch'`. Ctrl-C stops
watching and leaves the run alone.

**In a browser, over SSH.** The viewer listens on 127.0.0.1 only. Give it a fixed port and tell
it not to open a browser on the box:

```sh
ssh you@box 'cd your-repo && OSTOYAE_PORT=8765 OSTOYAE_NO_OPEN=1 ~/.local/bin/ostoyae watch --browser'
ssh -N -L 8765:127.0.0.1:8765 you@box
```

Then open http://localhost:8765 on your laptop. The viewer keeps running on the box after the
first command returns; the tunnel lasts as long as the second one.

**In a browser, over Tailscale.** On the box, after starting the viewer as above:

```sh
tailscale serve --bg localhost:8765
```

`tailscale serve` shares the port with devices on your tailnet only. Turn it off with
`tailscale serve localhost:8765 off`; `tailscale serve reset` clears every serve setting on the
box. Source: [tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve), read 2026-09-27.

The viewer has no login of its own. Anyone who can reach it can read the board, and it can also
start runs and confirm or reject proposals. Over `tailscale serve` that means every device your
tailnet access rules let through. Use `ssh -L` when that is more than you want.

**Never use `tailscale funnel` for the viewer.** Funnel publishes the port to the whole
internet, and the viewer would let anyone on the internet start runs on your machine, with your
agent login, against your repository.
