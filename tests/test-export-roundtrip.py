import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


root = Path(__file__).resolve().parents[1]
cache = root / ".cache"
cache.mkdir(exist_ok=True)
image = os.environ["EXPORT_TEST_IMAGE"]
digest = os.environ["IMAGE_MANIFEST_DIGEST"]
target_host = os.environ["EXPORT_TEST_DOCKER_HOST"]
source_host = os.environ["DOCKER_HOST"]
target_prefix = json.loads(os.environ.get("EXPORT_TEST_DOCKER_PREFIX", "[]"))
if not isinstance(target_prefix, list) or not all(isinstance(part, str) for part in target_prefix):
    raise ValueError("EXPORT_TEST_DOCKER_PREFIX must be a JSON array of command arguments")
if target_host == source_host:
    raise ValueError("Roundtrip requires a separate empty Docker store")


def source(*args):
    return subprocess.check_output(["docker", "--host", source_host, *args], text=True)


def target(*args):
    return subprocess.check_output([*target_prefix, "docker", "--host", target_host, *args], text=True)


if target("image", "ls", "--all", "--quiet").strip():
    raise ValueError("Roundtrip target must contain no images")
if target("info", "--format", "{{.ID}}").strip() == source("info", "--format", "{{.ID}}").strip():
    raise ValueError("Roundtrip target must be a distinct daemon")
before = json.loads(source("image", "inspect", image))[0]
with tempfile.TemporaryDirectory(dir=cache, prefix="export-roundtrip-") as directory:
    output = Path(directory) / "base.tar.gz"
    subprocess.run(["bash", str(root / "scripts/export-base.sh"), image, str(output)], check=True)
    assert output.stat().st_mode & 0o777 == 0o600
    for invalid_digest, invalid_tag in [("sha256:" + "0" * 64, "grok-box-base:missing"), (digest, "grok-box-base:missing")]:
        result = subprocess.run([sys.executable, str(root / "scripts/verify-export-identity.py"), str(output), invalid_digest, invalid_tag], capture_output=True)
        assert result.returncode != 0, "Identity verification must reject a different digest or repository tag"
    target("image", "load", "--input", str(output))
    reference = f"grok-box-base@{digest}"
    loaded = json.loads(target("image", "inspect", reference))[0]
    assert reference in loaded["RepoDigests"]
    assert loaded["Id"] == before["Id"]
    assert (loaded["Os"], loaded["Architecture"]) == ("linux", "arm64")
    assert loaded["Config"]["Labels"] == before["Config"]["Labels"]
    after = json.loads(source("image", "inspect", image))[0]
    assert after["RepoTags"] == before["RepoTags"], "Exporter must remove its tag and preserve user tags"
    assert after["Id"] == before["Id"]
    assert subprocess.run(["bash", str(root / "scripts/export-base.sh"), image, str(output)], capture_output=True).returncode != 0
print(f"Roundtrip passed: {reference}; source tags preserved; output mode 0600.")
