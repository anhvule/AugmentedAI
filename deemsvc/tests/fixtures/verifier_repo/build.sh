#!/usr/bin/env bash
# Builds a throwaway git repo with a baseline commit (2 passing tests) and a
# candidate commit (1 confirmed regression + 1 fix + 1 new passing test), for
# VerifierEngine integration tests. Usage: build.sh <target-dir>; echoes
# "<baseline_sha> <candidate_sha>" on the last line of stdout.
set -euo pipefail
dest="$1"
rm -rf "$dest"
mkdir -p "$dest"
cd "$dest"
git init -q
git config user.email test@example.com
git config user.name Test

mkdir -p tests
cat > tests/test_suite.py <<'EOF'
def test_stable():
    assert 1 == 1

def test_will_regress():
    assert 1 == 1

def test_currently_broken():
    assert 1 == 2
EOF
cat > pytest.ini <<'EOF'
[pytest]
addopts = -p no:cacheprovider
EOF
git add -A
git commit -q -m baseline
baseline=$(git rev-parse HEAD)

cat > tests/test_suite.py <<'EOF'
def test_stable():
    assert 1 == 1

def test_will_regress():
    assert 1 == 2  # regression

def test_currently_broken():
    assert 1 == 1  # fixed

def test_new_and_passing():
    assert True
EOF
git add -A
git commit -q -m candidate
candidate=$(git rev-parse HEAD)

echo "$baseline $candidate"
