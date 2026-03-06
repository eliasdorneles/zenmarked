#!/usr/bin/env bash
set -euo pipefail

# Release automation script for zenmarked
# Usage: ./scripts/release.sh [patch|minor|major]

BUMP_TYPE="${1:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

error() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

info() {
    echo -e "${GREEN}$1${NC}"
}

warn() {
    echo -e "${YELLOW}$1${NC}"
}

# Validate arguments
if [[ -z "$BUMP_TYPE" ]]; then
    error "Usage: ./scripts/release.sh [patch|minor|major]"
fi

if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
    error "Invalid bump type '$BUMP_TYPE'. Must be: patch, minor, or major"
fi

# Check for required tools
if ! command -v gh &> /dev/null; then
    error "GitHub CLI (gh) is not installed. Install it from: https://cli.github.com/"
fi

# Verify we're on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
    error "Must be on main branch (currently on: $CURRENT_BRANCH)"
fi

# Verify clean working directory
if [[ -n $(git status --porcelain) ]]; then
    error "Working directory is not clean. Commit or stash changes first."
fi

# Extract current version from pyproject.toml
CURRENT_VERSION=$(grep '^version = ' pyproject.toml | cut -d'"' -f2)
if [[ -z "$CURRENT_VERSION" ]]; then
    error "Could not extract current version from pyproject.toml"
fi

info "Current version: $CURRENT_VERSION"

# Parse semantic version components
if [[ ! "$CURRENT_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    error "Version '$CURRENT_VERSION' is not a valid semantic version (X.Y.Z)"
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

# Calculate new version
case "$BUMP_TYPE" in
    patch)
        NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
        ;;
    minor)
        NEW_VERSION="$MAJOR.$((MINOR + 1)).0"
        ;;
    major)
        NEW_VERSION="$((MAJOR + 1)).0.0"
        ;;
esac

info "New version: $NEW_VERSION"

# Check if tag already exists
if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
    error "Tag v$NEW_VERSION already exists"
fi

# Update version in pyproject.toml
info "Updating pyproject.toml..."
sed -i "s/^version = \".*\"/version = \"$NEW_VERSION\"/" pyproject.toml

# Update version in src/zenmarked/__init__.py
info "Updating src/zenmarked/__init__.py..."
sed -i "s/^__version__ = \".*\"/__version__ = \"$NEW_VERSION\"/" src/zenmarked/__init__.py

# Verify the updates worked
VERIFY_PYPROJECT=$(grep '^version = ' pyproject.toml | cut -d'"' -f2)
VERIFY_INIT=$(grep '^__version__ = ' src/zenmarked/__init__.py | cut -d'"' -f2)

if [[ "$VERIFY_PYPROJECT" != "$NEW_VERSION" ]] || [[ "$VERIFY_INIT" != "$NEW_VERSION" ]]; then
    error "Version update verification failed"
fi

# Stage modified files
info "Staging changes..."
git add pyproject.toml src/zenmarked/__init__.py

# Create commit
info "Creating commit..."
git commit -m "chore: bump version to $NEW_VERSION"

# Create annotated tag
info "Creating tag v$NEW_VERSION..."
git tag -a "v$NEW_VERSION" -m "Release $NEW_VERSION"

# Push commit and tag
info "Pushing to GitHub..."
git push origin main
git push origin "v$NEW_VERSION"

# Create draft release with auto-generated notes
info "Creating draft release..."
RELEASE_URL=$(gh release create "v$NEW_VERSION" --draft --generate-notes --title "v$NEW_VERSION" | tail -n 1)

echo ""
info "✓ Release v$NEW_VERSION prepared successfully!"
echo ""
echo "Next steps:"
echo "  1. Review the draft release at: $RELEASE_URL"
echo "  2. Edit release notes if needed"
echo "  3. Publish the release to trigger PyPI publishing"
echo ""
warn "The release is currently in DRAFT status and will NOT be published until you manually publish it."
