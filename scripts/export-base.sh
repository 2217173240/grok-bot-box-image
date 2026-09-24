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
EXPORT_TAG="grok-box-base:export-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
TAG_CREATED=false
cleanup() {
  rm -f "$PARTIAL"
  if test "$TAG_CREATED" = true && test "$(docker image inspect "$EXPORT_TAG" --format '{{.Id}}' 2>/dev/null || true)" = "$IMAGE_ID"; then
    docker image rm "$EXPORT_TAG" >/dev/null
  fi
}
trap cleanup EXIT
if docker image inspect "$EXPORT_TAG" >/dev/null 2>&1; then
  echo "Export tag already exists: $EXPORT_TAG" >&2
  exit 1
fi
# 独立名称保留导入后的仓库身份；它只指向已经核对的镜像，不再读取用户 tag。
docker image tag "$IMAGE_ID" "$EXPORT_TAG"
TAG_CREATED=true
docker image save "$EXPORT_TAG" | gzip -n > "$PARTIAL"
gzip -t "$PARTIAL"
python3 "$REPO/scripts/verify-export-identity.py" "$PARTIAL" "$EXPECTED_DIGEST" "$EXPORT_TAG"
python3 "$REPO/scripts/scan-image-archive.py" "$PARTIAL"
# 创建正式名称时要求目标不存在，防止并发导出覆盖已有文件。
ln "$PARTIAL" "$OUTPUT"
shasum -a 256 "$OUTPUT"
