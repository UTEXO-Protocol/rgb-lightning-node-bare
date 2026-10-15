#!/usr/bin/env python3
"""Verify the two npm payloads without compiling or changing native artifacts."""
import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import tarfile

OWNER = '@utexo/rgb-lightning-node-bare'
PAYLOAD = OWNER + '-ios'
IOS = ('ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator')
WRAPPER = ('darwin-arm64', 'android-arm64', 'android-arm', 'android-x64')
LIMIT = 210 * 1024 * 1024
FINGERPRINT_FILES = ('index.js', 'index.d.ts', 'json-boundary.js', 'binding.js', 'binding.cc', 'rln.h', 'CMakeLists.txt', 'scripts/native-overlay.js', 'scripts/build-cffi.sh', 'scripts/build-prebuilds.sh')


def digest_file(file, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest


def members(archive, limit):
    size = archive.stat().st_size
    if size > limit:
        raise ValueError('Distribution tarball exceeds 210 MiB: ' + str(archive))
    result = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = member.name
            if not member.isfile() or not name.startswith('package/') or str(pathlib.PurePosixPath(name)) != name or '..' in pathlib.PurePosixPath(name).parts or name in result:
                raise ValueError('Unexpected or duplicate archive member: ' + name)
            digest = hashlib.sha256()
            data = bytearray() if name in ('package/package.json', 'package/.utexo-native-overlay.json', 'package/runtime-contract.json') else None
            with tar.extractfile(member) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
                    if data is not None:
                        if len(data) + len(chunk) > 1024 * 1024:
                            raise ValueError('Oversized package metadata: ' + name)
                        data.extend(chunk)
            result[name] = {'bytes': bytes(data) if data is not None else None, 'sha256': digest.hexdigest(), 'mode': member.mode, 'size': member.size}
    return result


def verify_archives(root, wrapper_archive, ios_archive, limit=LIMIT):
    owner = json.loads((root / 'package.json').read_text())
    expected_manifest = (root / '.utexo-native-overlay.json').read_bytes()
    expected_runtime = (root / 'runtime-contract.json').read_bytes()
    manifest = json.loads(expected_manifest)
    archives = [wrapper_archive, ios_archive]
    contents = [members(p, limit) for p in archives]
    packages = [json.loads(c['package/package.json']['bytes']) for c in contents]
    wrapper, payload = packages
    if wrapper != owner:
        raise ValueError('Packed wrapper metadata differs from reviewed source')
    if wrapper['name'] != OWNER or payload['name'] != PAYLOAD or wrapper['version'] != owner['version'] or payload['version'] != owner['version']:
        raise ValueError('Distribution package identity mismatch')
    if wrapper.get('dependencies', {}).get(PAYLOAD) != owner['version'] or PAYLOAD in wrapper.get('optionalDependencies', {}):
        raise ValueError('Payload must be a required exact-version dependency')
    if any(name.startswith(('package/native/', 'package/node_modules/', 'package/.git/')) or name.endswith(('.a', '.tgz', '.pyc', '.log')) or name in ('package/package-lock.json', 'package/.git') for name in contents[0]):
        raise ValueError('Wrapper contains workspace, dependency or static archive data')
    for name, member in contents[0].items():
        relative = name.removeprefix('package/')
        automatic = relative in ('package.json', 'README.md', 'LICENSE')
        allowed = automatic or any(relative == item or relative.startswith(item.rstrip('/') + '/') for item in owner['files'])
        source = root / relative
        if not allowed or not source.is_file() or digest_file(source).hexdigest() != member['sha256']:
            raise ValueError('Unexpected or changed wrapper source file: ' + relative)
    if payload != json.loads((root / 'native' / 'ios' / 'package.json').read_text()):
        raise ValueError('Packed payload metadata differs from reviewed source')
    for name, package in zip(('wrapper', 'payload'), packages):
        if package.get('utexoNativeOverlay') != owner['utexoNativeOverlay']:
            raise ValueError(name + ' native graph mismatch')
    if payload.get('utexoNativePayload') != {'schemaVersion': 1, 'owner': OWNER, 'targets': list(IOS)}:
        raise ValueError('Payload target metadata mismatch')
    if any(field in payload for field in ('scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'os', 'cpu', 'libc', 'main', 'bin', 'addon')) or payload.get('exports') != {'./package.json': './package.json'}:
        raise ValueError('Payload is not portable data-only metadata')
    allowed_payload = {'package/package.json', 'package/LICENSE', 'package/README.md', 'package/.utexo-native-overlay.json', 'package/runtime-contract.json'} | {'package/prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare' for target in IOS}
    if set(contents[1]) != allowed_payload:
        raise ValueError('Unexpected payload archive member')
    for name, member in contents[1].items():
        source = root / 'native' / 'ios' / name.removeprefix('package/')
        if not source.is_file() or digest_file(source).hexdigest() != member['sha256']:
            raise ValueError('Unexpected or changed payload source file: ' + name)
    for content in contents:
        if content['package/.utexo-native-overlay.json']['bytes'] != expected_manifest or content['package/runtime-contract.json']['bytes'] != expected_runtime:
            raise ValueError('Packed native manifest/runtime contract changed')
    for name in FINGERPRINT_FILES:
        if contents[0]['package/' + name]['sha256'] != digest_file(root / name).hexdigest():
            raise ValueError('Native wrapper/build input changed: ' + name)
    assigned = []
    for content, targets in zip(contents, (WRAPPER, IOS)):
        expected = {'package/prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare' for target in targets}
        actual = {name for name in content if name.startswith('package/prebuilds/')}
        if actual != expected:
            raise ValueError('Native target partition mismatch')
        for target in targets:
            name = 'package/prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare'
            member = content[name]
            digest = member['sha256']
            source = root / 'prebuilds' / target / 'utexo__rgb-lightning-node-bare.bare'
            if not member['size'] or digest != manifest['artifacts'][target]['prebuildSha256'] or member['size'] != source.stat().st_size:
                raise ValueError('Original native bytes changed: ' + target)
            assigned.append({'target': target, 'sha256': digest, 'bytes': member['size']})
    if len(assigned) != 7 or len({a['target'] for a in assigned}) != 7:
        raise ValueError('The archive union must contain all seven original targets once')
    receipts = []
    for archive, package in zip(archives, packages):
        receipts.append({'name': package['name'], 'version': package['version'], 'path': str(archive.resolve()), 'bytes': archive.stat().st_size, 'sha256': digest_file(archive).hexdigest(), 'integrity': 'sha512-' + base64.b64encode(digest_file(archive, 'sha512').digest()).decode(), 'maximumBytes': limit})
    return {'archives': receipts, 'originalNativeTargets': assigned, 'nativeFingerprintsUnchanged': True, 'allSevenAssignedExactlyOnce': True, 'publicationPerformed': False}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: verify-distribution-archives.py WRAPPER.tgz IOS.tgz')
    root = pathlib.Path(__file__).resolve().parent.parent
    subprocess.run(['node', str(root / 'scripts/verify-distribution-artifacts.js')], check=True, stdout=sys.stderr)
    print(json.dumps(verify_archives(root, pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])), indent=2))
