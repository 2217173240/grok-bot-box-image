import hashlib
import json
import sys
import tarfile


archive_path, expected_digest, expected_tag = sys.argv[1:]
with tarfile.open(archive_path, "r:*") as archive:
    index = json.load(archive.extractfile("index.json"))
    manifests = index.get("manifests", [])
    if len(manifests) != 1 or manifests[0].get("digest") != expected_digest:
        raise ValueError("Exported OCI manifest does not match the reviewed digest")
    digest_hex = expected_digest.removeprefix("sha256:")
    content = archive.extractfile(f"blobs/sha256/{digest_hex}").read()
    if hashlib.sha256(content).hexdigest() != digest_hex:
        raise ValueError("Exported OCI manifest bytes do not match their digest")
    manifest = json.load(archive.extractfile("manifest.json"))
    if len(manifest) != 1 or manifest[0].get("RepoTags") != [expected_tag]:
        raise ValueError("Exported image must retain its dedicated grok-box-base tag")
print("Verified exported manifest digest and repository identity.")
