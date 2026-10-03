import json
import subprocess
import sys
import time
import uuid


image, platform = sys.argv[1:]
if platform not in ("linux/amd64", "linux/arm64"):
    raise ValueError("Unsupported image platform")


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True)


metadata = json.loads(docker("image", "inspect", image))[0]
assert f'{metadata["Os"]}/{metadata["Architecture"]}' == platform
for command in [("bun", "--version"), ("uv", "--version"), ("chromium", "--version"), ("node", "--version")]:
    print(docker("run", "--rm", "--network", "none", "--entrypoint", command[0], image, *command[1:]))
name = "grok-image-test-" + uuid.uuid4().hex
docker("run", "--detach", "--name", name, "--shm-size", "512m", "--security-opt", "seccomp=unconfined", image)
try:
    deadline = time.monotonic() + 90
    while True:
        ready = subprocess.run(["docker", "exec", name, "bash", "-c", "DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && curl -fsS http://127.0.0.1:6080/ >/dev/null"], capture_output=True)
        if ready.returncode == 0:
            break
        state = json.loads(docker("inspect", name))[0]["State"]
        if not state["Running"] or time.monotonic() >= deadline:
            print(docker("logs", name))
            raise RuntimeError("Desktop did not become ready")
        time.sleep(1)
    subprocess.run(["docker", "exec", name, "bash", "/usr/local/bin/gates.sh"], check=True, timeout=600)
finally:
    docker("rm", "--force", name)
print(f"Native image and desktop gates passed: {platform}")
