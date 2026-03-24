#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/Vibe-rator/Council-of-Elrond.git"
INSTALL_DIR="${ELROND_INSTALL_DIR:-$HOME/.elrond}"

info()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
error() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Check / install Bun
if ! command -v bun &>/dev/null; then
  info "Bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

info "Installing Council of Elrond → $INSTALL_DIR"

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

# Install dependencies
cd "$INSTALL_DIR"
bun install --production

# Create symlink
LINK_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$LINK_DIR"
ln -sf "$INSTALL_DIR/src/launcher.ts" "$LINK_DIR/elrond"
chmod +x "$INSTALL_DIR/src/launcher.ts"

# Check PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$LINK_DIR"; then
  info ""
  info "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  info "  export PATH=\"$LINK_DIR:\$PATH\""
fi

info ""
info "Done! Run 'elrond' to start a meeting."
