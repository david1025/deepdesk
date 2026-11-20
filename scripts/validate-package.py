#!/usr/bin/env python3
"""Cross-platform static checks (not a substitute for Xcode + macOS acceptance)."""
from pathlib import Path
import json, plistlib, sys
import yaml
root = Path(__file__).resolve().parents[1]
files = [
    'apps/macos/project.yml',
    'apps/macos/Config/Info.plist',
    'apps/macos/Config/DeepSeekMac.entitlements',
    'apps/macos/Sources/App/DeepSeekMacApp.swift',
    'apps/macos/Sources/Web/WebContainerView.swift',
    'apps/macos/Sources/Bridge/NativeBridge.swift',
    'apps/macos/Resources/Web/index.html',
    'contracts/bridge-v1.d.ts',
    'contracts/sync-v1.schema.json',
    'docs/macos/01-technical-plan.md',
    'docs/macos/06-v1-acceptance.md',
]
for path in files:
    assert (root / path).is_file(), f'Missing {path}'
with (root / 'apps/macos/project.yml').open() as f:
    spec = yaml.safe_load(f)
assert spec['targets']['DeepSeekMac']['platform'] == 'macOS'
for path in ['apps/macos/Config/Info.plist','apps/macos/Config/DeepSeekMac.entitlements']:
    with (root/path).open('rb') as f: plistlib.load(f)
with (root/'contracts/sync-v1.schema.json').open() as f: json.load(f)
with (root/'apps/macos/Resources/Web/index.html').open() as f:
    assert '<!doctype html>' in f.read().lower()
print(f'PASS: {len(files)} core files exist; XcodeGen YAML / plist / JSON parsed.')
print('NOTE: Swift compilation and runtime behavior require a real Mac with Xcode.')
