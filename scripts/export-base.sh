#!/bin/bash
set -euo pipefail
umask 077
IMAGE="${1:?usage: export-base.sh IMAGE OUTPUT}"
OUTPUT="${2:?usage: export-base.sh IMAGE OUTPUT}"
EXPECTED_REVISION="${SOURCE_REVISION:?Set SOURCE_REVISION to the reviewed image source commit}"
EXPECTED_DIGEST="${IMAGE_MANIFEST_DIGEST:?Set IMAGE_MANIFEST_DIGEST to the reviewed sha256 manifest digest}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$EXPECTED_REVISION" =~ ^[a-f0-9]{40}$ ]]
[[ "$EXPECTED_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
# 对照已审查的镜像身份、平台和来源，拒绝导出其他镜像。
IMAGE_ID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
IMMUTABLE_IMAGE=$(docker image inspect "$IMAGE_ID" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -E "@$EXPECTED_DIGEST$" | head -n 1)
test -n "$IMMUTABLE_IMAGE"
test "$(docker image inspect "$IMAGE_ID" --format '{{.Os}}/{{.Architecture}}')" = linux/arm64
test "$(docker image inspect "$IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')" = https://github.com/2217173240/grok-bot-box-image
test "$(docker image inspect "$IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_REVISION"
# 只导出镜像层，不导出容器、挂载目录或数据卷。
docker image inspect "$IMAGE_ID" --format '{{.Os}}/{{.Architecture}} {{.Id}}'
mkdir -p "$(dirname "$OUTPUT")"
if test -e "$OUTPUT"; then echo "Output already exists: $OUTPUT" >&2; exit 1; fi
PARTIAL=$(mktemp "${OUTPUT}.partial.XXXXXX")
trap 'rm -f "$PARTIAL"' EXIT
docker image save "$IMMUTABLE_IMAGE" | gzip -n > "$PARTIAL"
gzip -t "$PARTIAL"
python3 "$REPO/scripts/scan-image-archive.py" "$PARTIAL"
# 创建正式名称时要求目标不存在，防止并发导出覆盖已有文件。
ln "$PARTIAL" "$OUTPUT"
shasum -a 256 "$OUTPUT"
