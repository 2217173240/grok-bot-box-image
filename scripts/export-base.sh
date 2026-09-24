#!/bin/bash
set -euo pipefail
IMAGE="${1:?usage: export-base.sh IMAGE OUTPUT}"
OUTPUT="${2:?usage: export-base.sh IMAGE OUTPUT}"
EXPECTED_REVISION="${SOURCE_REVISION:?Set SOURCE_REVISION to the reviewed image source commit}"
EXPECTED_DIGEST="${IMAGE_MANIFEST_DIGEST:?Set IMAGE_MANIFEST_DIGEST to the reviewed sha256 manifest digest}"
[[ "$EXPECTED_REVISION" =~ ^[a-f0-9]{40}$ ]]
[[ "$EXPECTED_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
# 对照已审查的镜像身份、平台和来源，拒绝导出其他镜像。
IDENTITY="$(docker image inspect "$IMAGE" --format '{{json .RepoDigests}}')"
[[ "$IDENTITY" == *"@$EXPECTED_DIGEST\""* ]]
test "$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}')" = linux/arm64
test "$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')" = https://github.com/2217173240/grok-bot-box-image
test "$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_REVISION"
# 只导出镜像层，不导出容器、挂载目录或数据卷。
docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}} {{.Id}} {{json .Config.Labels}}'
mkdir -p "$(dirname "$OUTPUT")"
test ! -e "$OUTPUT"
docker image save "$IMAGE" | gzip -n > "$OUTPUT.partial"
gzip -t "$OUTPUT.partial"
mv "$OUTPUT.partial" "$OUTPUT"
shasum -a 256 "$OUTPUT"
