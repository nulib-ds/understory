#!/usr/bin/env python3
"""Publishes a built Understory as a release: one packaged template per region.

    scripts/build.sh
    scripts/release.py [--version 1.2.0] [--regions us-east-1 us-west-2]

For each region this writes, to s3://understory-releases-<region>/v<version>/,
the region's release bucket and the one source of truth for Understory
releases (read "The release buckets" in RELEASING.md):

    understory.yml          the packaged template an instance repo copies in
    understory.yml.sha256   its checksum, which an instance's deploy checks
    <hash> ...              every function's code and the UI layer, by content hash

Lambda reads code only from a bucket in its own region, hence a bucket per
region (app/aws/release-bucket.yml creates one). There is deliberately no option
to publish anywhere else: a pre-release (1.2.0-rc.1) goes to the same buckets,
under its own version, and is never reused.

Two things differ from a plain `sam package`:

  - The Release mapping gets the version, so a stack reports what it runs
    (the UnderstoryVersion output, /config.json).
  - BrandingLayer keeps its local path, branding/. An instance's `sam deploy`
    zips the branding folder beside its copy of the template, so each instance
    ships its own branding with no build of its own.

A version is never overwritten: if v<version>/understory.yml already exists in
a region's bucket, nothing is published anywhere.

The AWS CLI and SAM CLI use the usual credential chain (AWS_PROFILE, etc.),
which must reach NU's staging account, where the buckets live. In CI that is
understory-github-actions-release, which may write to these buckets and
nothing else.
"""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "app" / "aws" / ".aws-sam" / "build"
BUILT_TEMPLATE = BUILD_DIR / "template.yaml"
DIST = ROOT / "dist"
PLACEHOLDER = "s3://understory-branding-placeholder/branding.zip"
BUCKET = "understory-releases-{region}"
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


def run(*args, capture=False):
    print("+", " ".join(args), flush=True)
    result = subprocess.run(args, check=True, text=True, capture_output=capture)
    return result.stdout if capture else None


def object_exists(bucket, key, region):
    result = subprocess.run(
        ["aws", "s3api", "head-object", "--bucket", bucket, "--key", key, "--region", region],
        text=True,
        capture_output=True,
    )
    if result.returncode == 0:
        return True
    if "Not Found" in result.stderr or "404" in result.stderr:
        return False
    sys.exit(f"Could not check s3://{bucket}/{key}: {result.stderr.strip()}")


def stamp_version(text, version):
    stamped, count = re.subn(
        r"(\n\s+Version:\s*)['\"]?0\.0\.0-dev['\"]?", rf"\g<1>'{version}'", text, count=1
    )
    if count != 1:
        sys.exit("Could not find the Release mapping's 0.0.0-dev version in the built template.")
    return stamped


def swap_branding_uri(text, replacement):
    # BrandingLayer's block, up to the next resource at the same indent.
    pattern = re.compile(r"(\n  BrandingLayer[0-9A-Za-z]*:\n(?:    .*\n|\s*\n)*?\s+ContentUri:\s*)(\S+)")
    swapped, count = pattern.subn(lambda m: m.group(1) + replacement, text, count=1)
    if count != 1:
        sys.exit("Could not find BrandingLayer's ContentUri in the template.")
    return swapped


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", default=json.loads((ROOT / "package.json").read_text())["version"])
    parser.add_argument("--regions", nargs="+", default=["us-east-1"])
    args = parser.parse_args()

    if not SEMVER.match(args.version):
        sys.exit(f"{args.version} is not a semantic version.")
    if not BUILT_TEMPLATE.exists():
        sys.exit("No build to release. Run scripts/build.sh first.")

    prefix = f"v{args.version}"
    for region in args.regions:
        bucket = BUCKET.format(region=region)
        if object_exists(bucket, f"{prefix}/understory.yml", region):
            sys.exit(f"s3://{bucket}/{prefix}/understory.yml exists. A version is never overwritten: bump it.")

    built = BUILT_TEMPLATE.read_text()
    # Beside the built template, so its relative artifact paths still resolve.
    staged = BUILD_DIR / "release-template.yaml"
    staged.write_text(swap_branding_uri(stamp_version(built, args.version), PLACEHOLDER))

    for region in args.regions:
        bucket = BUCKET.format(region=region)
        out_dir = DIST / f"v{args.version}" / region
        out_dir.mkdir(parents=True, exist_ok=True)
        packaged = out_dir / "packaged.yml"
        run(
            "sam", "package",
            "--template-file", str(staged),
            "--s3-bucket", bucket,
            "--s3-prefix", prefix,
            "--region", region,
            "--output-template-file", str(packaged),
        )
        text = packaged.read_text()
        if PLACEHOLDER not in text:
            sys.exit("sam package dropped the branding placeholder; refusing to publish.")
        header = (
            f"# Understory v{args.version}, packaged for {region}.\n"
            "# Generated by scripts/release.py. Do not edit: an instance's deploy checks\n"
            "# this file against understory.yml.sha256 from the release bucket. Replace\n"
            "# it with scripts/upgrade <version> in the instance repo.\n"
        )
        template = out_dir / "understory.yml"
        template.write_text(header + text.replace(PLACEHOLDER, "branding/"))
        packaged.unlink()
        digest = hashlib.sha256(template.read_bytes()).hexdigest()
        checksum = out_dir / "understory.yml.sha256"
        checksum.write_text(f"{digest}  understory.yml\n")
        for path in (template, checksum):
            run("aws", "s3", "cp", str(path), f"s3://{bucket}/{prefix}/{path.name}", "--region", region)
        print(f"Published s3://{bucket}/{prefix}/understory.yml  sha256 {digest}")

    staged.unlink()


if __name__ == "__main__":
    main()
