import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile


root = Path(__file__).resolve().parents[1]
cache = root / ".cache"
cache.mkdir(exist_ok=True)
scanner = os.environ.get("GITLEAKS_BIN", "gitleaks")
version = subprocess.check_output([scanner, "version"], text=True).strip().lstrip("v")
if version != "8.30.1":
    raise ValueError("Image scan requires reviewed Gitleaks 8.30.1")
policy = json.loads((root / "security/reviewed-image-materials.json").read_text())
if policy.get("version") != 1 or not isinstance(policy.get("entries"), list):
    raise ValueError("Invalid reviewed image material policy")
reviewed = {}
for entry in policy["entries"]:
    path = PurePosixPath(entry["path"])
    if ".." in path.parts or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
        raise ValueError("Invalid reviewed image material identity")
    if path.is_absolute():
        path = path.relative_to("/")
    for rule in entry["ruleIds"]:
        identity = (str(path), rule)
        if identity in reviewed:
            raise ValueError("Duplicate reviewed image material identity")
        reviewed[identity] = entry["sha256"]
forbidden = re.compile(r"(^|/)(auth\.json|credentials\.json|user-secrets\.json|box-secrets\.json|anthropic-token|Cookies(?:-journal)?|Login Data(?:-journal)?|id_rsa|id_ed25519)$|(^|/)(\.aws|\.ssh|\.claude|\.codex)/")
findings = False
scanned_layers = 0


def scan(directory):
    global findings
    report = cache / (Path(directory).name + ".redacted.json")
    result = subprocess.run([
        scanner, "dir", "--redact=100", "--no-banner", "--no-color",
        "--config=" + str(root / ".gitleaks-image.toml"), "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path=" + str(cache / "no-image-allowlist"),
        "--max-decode-depth=2", "--timeout=180", "--report-format=json",
        "--report-path=" + str(report), str(directory)
    ], capture_output=True, text=True)
    if " ERR " in result.stderr:
        raise RuntimeError("Image content scan reported unreadable input; inspect the local redacted report")
    if result.returncode not in (0, 1):
        raise RuntimeError("Image content scan failed")
    accepted = 0
    for item in json.loads(report.read_text()):
        path = Path(item["File"])
        relative = path.relative_to(directory).as_posix()
        expected = reviewed.get((relative, item["RuleID"]))
        if expected is not None and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
            accepted += 1
            continue
        findings = True
        print(json.dumps({"rule": item["RuleID"], "path": item["File"], "line": item["StartLine"]}), flush=True)
    print(f"Reviewed public-material matches: {accepted}", flush=True)


with tarfile.open(sys.argv[1], "r:*") as archive:
    manifest = json.load(archive.extractfile("manifest.json"))
    if not isinstance(manifest, list) or len(manifest) != 1:
        raise ValueError("Export must contain exactly one Docker image")
    record = manifest[0]
    if not isinstance(record.get("Layers"), list) or not record["Layers"]:
        raise ValueError("Export has no image layers")
    with tempfile.TemporaryDirectory(dir=cache, prefix="image-config-scan-") as temporary:
        config = json.load(archive.extractfile(record["Config"]))
        Path(temporary, "config.json").write_text(json.dumps(config))
        scan(temporary)
    # 分层检查，后续层删除的文件也必须接受扫描。
    for index, layer in enumerate(record["Layers"]):
        with tempfile.TemporaryDirectory(dir=cache, prefix="image-layer-scan-") as temporary:
            target = Path(temporary)
            with tarfile.open(fileobj=archive.extractfile(layer), mode="r|*") as contents:
                for member in contents:
                    relative = PurePosixPath(member.name)
                    if relative.is_absolute() or ".." in relative.parts:
                        raise ValueError("Unsafe image archive path")
                    if not member.isfile():
                        continue
                    if forbidden.search(str(relative)):
                        print(f"Forbidden runtime credential/session path in layer {index}: {relative}", file=sys.stderr)
                        findings = True
                    destination = target.joinpath(*relative.parts)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with contents.extractfile(member) as source, destination.open("wb") as output:
                        shutil.copyfileobj(source, output)
            print(f"Scanning image layer {index + 1}/{len(record['Layers'])}", flush=True)
            scan(target)
            scanned_layers += 1
print(f"Scanned image configuration and {scanned_layers} separate layers; findings={findings}.")
sys.exit(1 if findings else 0)
