#!/usr/bin/env bash
# Install Ostoyae for this user. No sudo, no npm, nothing outside your home directory.
#
#   curl -fsSL https://raw.githubusercontent.com/teal-sea/ostoyae/main/install.sh | bash
#   bash install.sh [--ref REF] [--uninstall]
#
# What it does:
#   1. checks Node.js 22+, git, bash and python3, and prints the install command for this
#      system when one is missing
#   2. fetches REF (default main) from OSTOYAE_REPO with git, or a tarball with curl when git
#      cannot fetch it, or copies a local checkout named by OSTOYAE_SOURCE
#   3. installs into OSTOYAE_HOME (default ~/.ostoyae), replacing an earlier install there
#   4. links OSTOYAE_BIN/ostoyae (default ~/.local/bin/ostoyae) to it
#
# Re-running upgrades. --uninstall removes the install and the link and nothing else: boards,
# branches, worktrees and ~/.local/state/ostoyae are yours and stay where they are.
#
# Environment: OSTOYAE_REPO, OSTOYAE_REF, OSTOYAE_SOURCE, OSTOYAE_HOME, OSTOYAE_BIN.
set -eu

REPO="${OSTOYAE_REPO:-https://github.com/teal-sea/ostoyae}"
REF="${OSTOYAE_REF:-main}"
SOURCE="${OSTOYAE_SOURCE:-}"
DEST="${OSTOYAE_HOME:-$HOME/.ostoyae}"
BIN="${OSTOYAE_BIN:-$HOME/.local/bin}"
MARKER=".ostoyae-install"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

# macos, debian (Debian, Ubuntu and relatives), wsl, or linux.
system() {
  case "$(uname -s)" in
    Darwin) echo macos; return ;;
    Linux) ;;
    *) echo other; return ;;
  esac
  if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl; return; fi
  if [ -r /etc/os-release ] && grep -Eqi '^(ID|ID_LIKE)=.*(debian|ubuntu)' /etc/os-release; then echo debian; return; fi
  echo linux
}

# The command that installs one missing requirement on this system.
hint() {
  local what="$1" os="$2"
  case "$what:$os" in
    node:macos) echo "brew install node   (or: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash && nvm install 22)" ;;
    node:*) echo "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash && nvm install 22   (no sudo; open a new shell after the first half)" ;;
    git:macos) echo "xcode-select --install   (or: brew install git)" ;;
    python3:macos) echo "xcode-select --install   (or: brew install python)" ;;
    git:debian|git:wsl) echo "sudo apt-get install -y git" ;;
    python3:debian|python3:wsl) echo "sudo apt-get install -y python3" ;;
    bash:macos) echo "bash ships with macOS; check your PATH" ;;
    bash:debian|bash:wsl) echo "sudo apt-get install -y bash" ;;
    *:linux) echo "install $what with your distribution's package manager, for example: sudo dnf install $what" ;;
    *) echo "install $what" ;;
  esac
}

requirements() {
  local os missing=0 major
  os=$(system)
  if [ "$os" = other ]; then die "Ostoyae runs on macOS, Linux and WSL. On Windows, run this inside WSL."; fi
  if command -v node >/dev/null 2>&1; then
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    case "$major" in ''|*[!0-9]*) major=0 ;; esac
    if [ "$major" -lt 22 ]; then
      say "node $(node --version) is too old; Ostoyae needs 22 or later."
      say "  $(hint node "$os")"; missing=1
    fi
  else
    say "node is missing; Ostoyae needs Node.js 22 or later."
    say "  $(hint node "$os")"; missing=1
  fi
  for tool in git bash python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      say "$tool is missing."
      say "  $(hint "$tool" "$os")"; missing=1
    fi
  done
  if [ "$missing" = 1 ]; then die "Install what is missing above, then run this again. Nothing was installed."; fi
}

# Put the source tree into $1.
fetch() {
  local into="$1"
  if [ -n "$SOURCE" ]; then
    [ -d "$SOURCE" ] || die "OSTOYAE_SOURCE=$SOURCE is not a directory."
    say "copying $SOURCE"
    if git -C "$SOURCE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      # Tracked and untracked-but-not-ignored files, as they are on disk, so uncommitted edits
      # are what gets installed. Deleted tracked files are skipped.
      (cd "$SOURCE" && git ls-files -z --cached --others --exclude-standard \
        | python3 -c 'import os,sys; sys.stdout.buffer.write(b"".join(p+b"\0" for p in sys.stdin.buffer.read().split(b"\0") if p and os.path.lexists(p)))' \
        | tar --null -T - -cf -) | (cd "$into" && tar -xf -)
    else
      (cd "$SOURCE" && tar -cf - .) | (cd "$into" && tar -xf -)
    fi
    SOURCE_DESC="$SOURCE"
    COMMIT=$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)
    return
  fi
  say "fetching $REF from $REPO"
  if git init -q "$into" && git -C "$into" fetch -q --depth 1 "$REPO" "$REF" 2>/dev/null \
     && git -C "$into" -c advice.detachedHead=false checkout -q FETCH_HEAD; then
    COMMIT=$(git -C "$into" rev-parse HEAD)
    rm -rf "$into/.git"
  else
    rm -rf "$into" && mkdir -p "$into"
    command -v curl >/dev/null 2>&1 || die "git could not fetch $REF from $REPO, and curl is not installed for the tarball."
    say "git could not fetch it; trying the tarball"
    curl -fsSL "$REPO/archive/$REF.tar.gz" | tar -xzf - -C "$into" --strip-components 1 \
      || die "Could not fetch $REF from $REPO. Check the ref and your access to the repository. Nothing was installed."
  fi
  SOURCE_DESC="$REPO@$REF"
}

install() {
  requirements
  local parent old=""
  parent=$(dirname "$DEST")
  mkdir -p "$parent"
  if [ -e "$DEST" ] && [ ! -f "$DEST/$MARKER" ]; then
    die "$DEST exists and was not made by this installer. Move it, or set OSTOYAE_HOME to another path. Nothing was installed."
  fi
  STAGE=$(mktemp -d "$parent/.ostoyae-stage.XXXXXX")
  trap 'rm -rf "$STAGE"' EXIT
  local stage="$STAGE"
  COMMIT=""
  SOURCE_DESC=""
  fetch "$stage"
  [ -f "$stage/cli.mjs" ] && [ -f "$stage/bin/ostoyae" ] || die "What was fetched is not an Ostoyae tree (no cli.mjs). Nothing was installed."
  chmod +x "$stage/bin/ostoyae"
  printf 'source=%s\ncommit=%s\ninstalled=%s\n' "$SOURCE_DESC" "${COMMIT:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/$MARKER"
  node "$stage/cli.mjs" version >/dev/null || die "The fetched copy does not run: node $stage/cli.mjs version failed. Nothing was installed."

  # Move the old install aside before moving the new one in, so a runner still running from the
  # old files keeps the files it has open, and a failure leaves one complete install in place.
  local verb=installed
  if [ -e "$DEST" ]; then
    old="$parent/.ostoyae-old.$$"
    mv "$DEST" "$old"
    verb=upgraded
  fi
  if ! mv "$stage" "$DEST"; then
    if [ -n "$old" ]; then mv "$old" "$DEST"; fi
    die "Could not move the new install into $DEST. The previous install is unchanged."
  fi
  trap - EXIT
  if [ -n "$old" ]; then rm -rf "$old"; fi

  mkdir -p "$BIN"
  if [ -e "$BIN/ostoyae" ] || [ -L "$BIN/ostoyae" ]; then
    case "$(readlink "$BIN/ostoyae" 2>/dev/null || true)" in
      "$DEST/bin/ostoyae") ;;
      *) die "$BIN/ostoyae exists and does not point at $DEST. Remove it or set OSTOYAE_BIN. The install is in $DEST." ;;
    esac
  fi
  ln -sfn "$DEST/bin/ostoyae" "$BIN/ostoyae"

  say "$verb $("$DEST/bin/ostoyae" version) into $DEST"
  say "linked $BIN/ostoyae"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
      # The tildes are printed for a person to paste, not expanded here.
      # shellcheck disable=SC2088
      local rc="~/.profile" shown="$BIN"
      # shellcheck disable=SC2088
      case "${SHELL:-}" in */zsh) rc="~/.zshrc" ;; */bash) rc="~/.bashrc" ;; esac
      case "$BIN" in "$HOME"/*) shown="\$HOME/${BIN#"$HOME"/}" ;; esac
      say ""
      say "$BIN is not on your PATH. Add it:"
      say "  echo 'export PATH=\"$shown:\$PATH\"' >> $rc && export PATH=\"$BIN:\$PATH\""
      ;;
  esac
  say ""
  say "next:  ostoyae demo     scripted agents, no model calls"
  say ""
}

uninstall() {
  local removed=0
  if [ -L "$BIN/ostoyae" ] && [ "$(readlink "$BIN/ostoyae")" = "$DEST/bin/ostoyae" ]; then
    rm -f "$BIN/ostoyae"; say "removed $BIN/ostoyae"; removed=1
  fi
  if [ -d "$DEST" ]; then
    [ -f "$DEST/$MARKER" ] || die "$DEST was not made by this installer; leaving it alone."
    rm -rf "$DEST"; say "removed $DEST"; removed=1
  fi
  [ "$removed" = 1 ] || say "nothing to remove: no install at $DEST"
  say "Boards, ost/* branches, worktrees and ~/.local/state/ostoyae were not touched."
}

main() {
  local action=install
  while [ $# -gt 0 ]; do
    case "$1" in
      --uninstall) action=uninstall ;;
      --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift ;;
      --ref=*) REF="${1#--ref=}" ;;
      -h|--help) say "install.sh [--ref REF] [--uninstall]"; say "Installs Ostoyae into $DEST and links $BIN/ostoyae. Re-run to upgrade."; return 0 ;;
      *) die "unknown argument $1. Use --ref REF or --uninstall." ;;
    esac
    shift
  done
  [ -n "${HOME:-}" ] || die "HOME is not set."
  "$action"
}

# Everything above only defines functions, so a download cut short runs nothing.
main "$@"
