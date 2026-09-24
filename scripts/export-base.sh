#!/bin/bash
set -euo pipefail
IMAGE="${1:?usage: export-base.sh IMAGE OUTPUT}"
OUTPUT="${2:?usage: export-base.sh IMAGE OUTPUT}"
# 只导出镜像层，不导出容器、挂载目录或数据卷。
docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}} {{.Id}} {{json .Config.Labels}}'
mkdir -p "$(dirname "$OUTPUT")"
test ! -e "$OUTPUT"
docker image save "$IMAGE" | gzip -n > "$OUTPUT.partial"
gzip -t "$OUTPUT.partial"
mv "$OUTPUT.partial" "$OUTPUT"
shasum -a 256 "$OUTPUT"
