#!/usr/bin/env bash
set -euo pipefail

MIN_MAJOR=3
MIN_MINOR=11
VENV="${HIDEOUT_VENV:-$HOME/.venv/hideout}"
BIN_DIR="${HIDEOUT_BIN_DIR:-$HOME/.local/bin}"
REPO_TARBALL="${HIDEOUT_TARBALL:-https://github.com/papodaca/hideout/archive/refs/heads/main.tar.gz}"

die() {
  echo "install.sh: $*" >&2
  exit 1
}

python_ok() {
  local py=$1
  [ -x "$py" ] || return 1
  "$py" -c "import sys, venv; raise SystemExit(0 if sys.version_info >= (${MIN_MAJOR}, ${MIN_MINOR}) else 1)" 2>/dev/null
}

find_python() {
  local py name
  if [ -n "${HIDEOUT_PYTHON:-}" ]; then
    python_ok "$HIDEOUT_PYTHON" || die "HIDEOUT_PYTHON ($HIDEOUT_PYTHON) is not Python ${MIN_MAJOR}.${MIN_MINOR}+ with the venv module"
    echo "$HIDEOUT_PYTHON"
    return
  fi

  for py in /usr/bin/python3 /usr/local/bin/python3; do
    if python_ok "$py"; then
      echo "$py"
      return
    fi
  done

  for name in python3.14 python3.13 python3.12 python3.11 python3 python; do
    py="$(command -v "$name" 2>/dev/null || true)"
    [ -n "$py" ] || continue
    case "$py" in
      "$VENV"/*) continue ;;
    esac
    if python_ok "$py"; then
      echo "$py"
      return
    fi
  done

  die "need Python ${MIN_MAJOR}.${MIN_MINOR} or newer on PATH (with the venv module)"
}

rc_mentions_bin_dir() {
  local rc=$1
  [ -f "$rc" ] || return 1
  grep -qF "$BIN_DIR" "$rc" && return 0
  grep -qE '(^|[^[:alnum:]_])(\$HOME|\$\{HOME\}|~)/\.local/bin' "$rc"
}

append_path_sh() {
  local rc=$1
  local line="export PATH=\"${BIN_DIR}:\$PATH\""
  if rc_mentions_bin_dir "$rc"; then
    return 1
  fi
  if [ -e "$rc" ] && [ ! -f "$rc" ]; then
    return 1
  fi
  mkdir -p "$(dirname "$rc")"
  if [ -f "$rc" ] && [ -s "$rc" ] && [ "$(tail -c 1 "$rc" 2>/dev/null || true)" != "" ]; then
    printf '\n' >> "$rc"
  fi
  printf '\n# hideout\n%s\n' "$line" >> "$rc"
  return 0
}

append_path_fish() {
  local rc=$1
  if [ -f "$rc" ] && grep -qF "$BIN_DIR" "$rc"; then
    return 1
  fi
  mkdir -p "$(dirname "$rc")"
  printf '\n# hideout\nfish_add_path %s\n' "$BIN_DIR" >> "$rc"
  return 0
}

persist_path() {
  local shell_name rc
  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh)
      rc="${ZDOTDIR:-$HOME}/.zshrc"
      append_path_sh "$rc" || return 1
      echo "$rc"
      ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        rc="$HOME/.bashrc"
      else
        rc="$HOME/.bash_profile"
      fi
      append_path_sh "$rc" || return 1
      echo "$rc"
      ;;
    fish)
      rc="$HOME/.config/fish/config.fish"
      append_path_fish "$rc" || return 1
      echo "$rc"
      ;;
    *)
      rc="$HOME/.profile"
      append_path_sh "$rc" || return 1
      echo "$rc"
      ;;
  esac
}

PY="$(find_python)"
PY_VER="$("$PY" -c "import sys; print('.'.join(map(str, sys.version_info[:3])))")"
echo "python  $PY ($PY_VER)"

mkdir -p "$(dirname "$VENV")"
if [ ! -x "$VENV/bin/python" ]; then
  echo "venv    creating $VENV"
  if ! "$PY" -m venv "$VENV"; then
    die "could not create $VENV with $PY (install the distro venv package if this is Debian/Ubuntu)"
  fi
else
  echo "venv    $VENV"
fi

if ! "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
  "$VENV/bin/python" -m ensurepip --upgrade
fi

script_path="${BASH_SOURCE[0]:-}"
src_dir=""
if [ -n "$script_path" ] && [ -f "$script_path" ]; then
  src_dir="$(cd "$(dirname "$script_path")" && pwd)"
fi
if [ -n "$src_dir" ] && [ -f "$src_dir/pyproject.toml" ]; then
  echo "pip     installing hideout from $src_dir"
  "$VENV/bin/python" -m pip install -e "$src_dir"
else
  echo "pip     installing hideout from $REPO_TARBALL"
  "$VENV/bin/python" -m pip install --upgrade "$REPO_TARBALL"
fi

mkdir -p "$BIN_DIR"
ln -sfn "$VENV/bin/hideout" "$BIN_DIR/hideout"
echo "bin     $BIN_DIR/hideout -> $VENV/bin/hideout"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    PATH_NOTE="on PATH"
    ;;
  *)
    PATH_NOTE="not on PATH yet"
    if rc="$(persist_path)"; then
      echo "path    added ${BIN_DIR} to ${rc}"
    else
      echo "path    ${BIN_DIR} is missing from this shell; add it with:"
      echo "        export PATH=\"${BIN_DIR}:\$PATH\""
    fi
    ;;
esac

if [ "$PATH_NOTE" = "on PATH" ]; then
  echo "path    $BIN_DIR already on PATH"
fi

if [ -x "$BIN_DIR/hideout" ]; then
  echo "ok      hideout"
fi
