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
# 使用生产状态文件规则隔离常驻同步；S3 probe 自行发布状态并运行真实同步进程。
docker("run", "--detach", "--name", name, "--shm-size", "512m", "--security-opt", "seccomp=unconfined",
       "--env", "SAND_SESSION_SYNC_STATE_FILE=/home/box/.cache/ci-activity.json", image)
try:
    deadline = time.monotonic() + 90
    ready_checks = [
        "DISPLAY=:1 xdpyinfo >/dev/null 2>&1",
        "curl -fsS http://127.0.0.1:6080/ >/dev/null",
        "curl -fsS http://127.0.0.1:18765/v1/screens >/dev/null",
        "DISPLAY=:1 xwininfo -root -children | grep -q '\"plank\"'",
        "DISPLAY=:1 xwininfo -root -children | grep -oE '184x66\\+[0-9]+\\+[0-9]+' | awk -F'+' '$3 >= 700 { found=1 } END { exit !found }'",
    ]
    while True:
        ready = subprocess.run(["docker", "exec", name, "bash", "-c", " && ".join(ready_checks)], capture_output=True)
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
