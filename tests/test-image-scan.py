import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile


root = Path(__file__).resolve().parents[1]
(root / ".cache").mkdir(exist_ok=True)


def add(archive, name, value):
    info = tarfile.TarInfo(name)
    info.size = len(value)
    archive.addfile(info, io.BytesIO(value))


def layer(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, value in files.items():
            add(archive, name, value)
    return buffer.getvalue()


with tempfile.TemporaryDirectory(dir=root / ".cache", prefix="image-scan-test-") as temporary:
    directory = Path(temporary)
    key = directory / "generated.pem"
    subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(key)], check=True, capture_output=True)
    for name, layers, expected in [
        ("clean", [{"public.txt": b"public content"}], 0),
        ("removed-key", [{"key.pem": key.read_bytes()}, {".wh.key.pem": b""}], 1),
        ("runtime-data", [{"home/box/.codex/auth.json": b"{}"}], 1),
    ]:
        output = directory / f"{name}.tar.gz"
        paths = [f"layer-{index}.tar" for index in range(len(layers))]
        with tarfile.open(output, "w:gz") as archive:
            add(archive, "manifest.json", json.dumps([{"Config": "config.json", "Layers": paths}]).encode())
            add(archive, "config.json", b"{}")
            for path, files in zip(paths, layers):
                add(archive, path, layer(files))
        result = subprocess.run([sys.executable, str(root / "scripts/scan-image-archive.py"), str(output)], capture_output=True, text=True)
        assert result.returncode == expected, (name, result.stderr)
        assert key.read_text() not in result.stdout + result.stderr
        if name == "removed-key":
            assert "private-key" in result.stdout
        print(f"Image scan scenario passed: {name}")
