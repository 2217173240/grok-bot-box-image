import os
import io
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)
os.environ["TMPDIR"] = str(CACHE)
tempfile.tempdir = str(CACHE)


def run(*args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)


tracked = run("git", "ls-files", "-z", capture_output=True).stdout.decode().split("\0")
expected = {
    path for path in tracked
    if path.startswith("box-image/bin/")
    or path in ("box-service/package.json", "box-service/package-lock.json", "box-service/server.mjs")
    or (path.startswith("box-service/lib/") and path.endswith((".mjs", ".py")))
}
names = (
    ".env", ".env.local", ".npmrc", ".ssh/id_rsa", ".claude/settings.json",
    ".codex/auth.json", "credentials", "credentials.json", "credentials.yaml",
    "auth.json", "auth.local.json", "user-secrets", "user-secrets.json",
    "box-secrets.json", "credentials.yml", "private.pem", "private.key",
    "private.p12", "private.pfx", "id_rsa", "id_ed25519",
    "chrome-profile/Default/Cookies", "chromium-profile/Local State",
    "browser-profile/Default/Login Data", "user-data-dir/Default/Cookies",
    "sand-data/chrome-profile/Default/Cookies", "Cookies", "Cookies-journal",
    "Login Data", "Login Data-journal", "Local State",
)
markers = {f"{prefix}{name}" for prefix in ("", "box-image/bin/", "box-service/", "box-service/lib/") for name in names}
assert not expected & markers
for marker in markers:
    run("git", "check-ignore", "--no-index", "-q", marker)
for source in expected:
    result = subprocess.run(("git", "check-ignore", "--no-index", "-q", source), cwd=ROOT)
    assert result.returncode == 1, f"Required source ignored by Git: {source}"
print(f"Git ignore checks passed: {len(markers)} sensitive paths, {len(expected)} sources.", flush=True)

with tempfile.TemporaryDirectory(prefix="publication-context-") as temporary:
    context = Path(temporary) / "context"
    context.mkdir()
    shutil.copyfile(ROOT / ".dockerignore", context / ".dockerignore")
    for relative in expected:
        target = context / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    for relative in markers | {"unrelated.txt", "box-image/bin/notes.txt", "box-service/notes.txt", "box-service/lib/notes.txt"}:
        target = context / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("harmless publication-safety fixture\n")
    image = f"publication-safety-test:{uuid.uuid4().hex}"
    container = None
    try:
        run("docker", "build", "--no-cache", "-t", image, "-f", "-", str(context),
            input=b"FROM scratch\nCOPY . /context/\n")
        container = run("docker", "create", image, "/unused", capture_output=True).stdout.decode().strip()
        exported = run("docker", "export", container, capture_output=True).stdout
        with tarfile.open(fileobj=io.BytesIO(exported)) as archive:
            actual = {entry.name.removeprefix("context/") for entry in archive
                      if entry.isfile() and entry.name.startswith("context/")}
    finally:
        if container:
            run("docker", "rm", container, stdout=subprocess.DEVNULL)
        subprocess.run(("docker", "image", "rm", image), cwd=ROOT, stdout=subprocess.DEVNULL)
    assert actual == expected, f"Docker context mismatch: missing={expected - actual}, unexpected={actual - expected}"
print("Docker COPY checks passed: only required source files entered the image.")
