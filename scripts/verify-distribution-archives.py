#!/usr/bin/env python3
"""Admit four byte-preserving npm payloads; never extract or execute a member."""
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import stat
import sys
import tarfile

OWNER = '@utexo/rgb-lightning-node-bare'
PAYLOAD = OWNER + '-ios'  # Preserve the original iOS fixture/publication identity.
IOS = ('ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator')
WRAPPER = ('darwin-arm64',)
PAYLOADS = (
    {'name': PAYLOAD, 'directory': 'native/ios', 'targets': IOS},
    {'name': OWNER + '-android-arm', 'directory': 'native/android-arm', 'targets': ('android-arm', 'android-arm64')},
    {'name': OWNER + '-android-x64', 'directory': 'native/android-x64', 'targets': ('android-x64',)},
)
LIMIT = 128 * 1024 * 1024
CANDIDATE_VERSION = '0.2.0-bfa.0'
CANDIDATE_IDENTITY_ENV = 'RLN_BARE_CANDIDATE_IOS_IDENTITY'
CANDIDATE_IDENTITY_SHA256_ENV = 'RLN_BARE_CANDIDATE_IOS_IDENTITY_SHA256'
CANDIDATE_RECORD_LIMIT = 16 * 1024
FROZEN_IOS = {
    'size': 146197231,
    'integrity': 'sha512-BOfizU4fqvGyl4L2Q0YAikLEYGyOBDYQikYPPR7IgxnmKrddm3T1/Lv0YnQeYt1EsBOf2SGyLNJKOLaWOglrkg==',
    'sourceCommit': '15b0ff68d1b59fa88131cfb9be6fe48c30287e6b',
}
BETA5_IOS = {
    'size': 143638135,
    'integrity': 'sha512-UdhulayuKoaHKaM/CkpRf2paetb8y4Mhaw58snFO+WALAo4Bgd5OqxbK8Pcae9Llu78xrrrOIs3hlxQoOXBUwA==',
    'sourceCommit': None,  # Unpublished candidate; compilation provenance is separate.
    'published': False,
}
FINGERPRINT_FILES = ('index.js', 'index.d.ts', 'json-boundary.js', 'binding.js', 'binding.cc', 'rln.h', 'CMakeLists.txt', 'scripts/native-overlay.js', 'scripts/build-cffi.sh', 'scripts/build-prebuilds.sh')


def digest_file(file, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest


def members(archive, limit):
    if archive.stat().st_size > limit:
        raise ValueError('Distribution tarball exceeds its frozen size budget: ' + str(archive))
    result = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = member.name
            if not member.isfile() or not name.startswith('package/') or str(pathlib.PurePosixPath(name)) != name or '..' in pathlib.PurePosixPath(name).parts or '\\' in name or name in result:
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


def wrapper_inventory(root, owner):
    # Select the reviewed source inventory, not whatever happened to be packed.
    # Unignored new source files support local pre-commit qualification; release
    # CI separately checks out the frozen clean main commit.
    top = subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], text=True).strip()
    if pathlib.Path(top).resolve() != root.resolve():
        raise ValueError('Archive verification requires the package Git root')
    tracked = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode().split('\0')
    automatic = {'package.json', 'README.md', 'LICENSE'}
    expected = {'package/' + name for name in tracked if name and (name in automatic or any(name == item or name.startswith(item.rstrip('/') + '/') for item in owner['files']))}
    expected |= {'package/' + name for name in automatic | {'.utexo-native-overlay.json'}}
    expected |= {'package/prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare' for target in WRAPPER}
    return expected


def verify_source_member(source, member, label):
    if source.is_symlink() or not source.is_file() or digest_file(source).hexdigest() != member['sha256']:
        raise ValueError('Unexpected or changed ' + label)
    mode = stat.S_IMODE(source.stat().st_mode)
    # npm preserves permission bits. The generated manifest is deliberately
    # 0600 in the already-published iOS archive; other members are ordinary
    # data/source files or executable maintainer scripts.
    allowed = (0o600, 0o644) if source.name == '.utexo-native-overlay.json' else (0o644, 0o755)
    if mode not in allowed or member['mode'] != mode:
        raise ValueError('Unexpected archive member mode: ' + str(source))


def candidate_ios_identity(environment=None):
    environment = os.environ if environment is None else environment
    file = environment.get(CANDIDATE_IDENTITY_ENV)
    expected_sha256 = environment.get(CANDIDATE_IDENTITY_SHA256_ENV)
    error = 'Candidate iOS archive requires an independently frozen identity record and SHA-256'
    if not isinstance(file, str) or not pathlib.Path(file).is_absolute() or not isinstance(expected_sha256, str) or not re.fullmatch('[a-f0-9]{64}', expected_sha256):
        raise ValueError(error)
    try:
        path_info = os.lstat(file)
        if not stat.S_ISREG(path_info.st_mode) or path_info.st_size > CANDIDATE_RECORD_LIMIT:
            raise ValueError(error)
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_size > CANDIDATE_RECORD_LIMIT or (path_info.st_dev, path_info.st_ino) != (before.st_dev, before.st_ino):
                raise ValueError(error)
            chunks = []
            remaining = CANDIDATE_RECORD_LIMIT + 1
            while remaining:
                chunk = os.read(descriptor, remaining)
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b''.join(chunks)
            after = os.fstat(descriptor)
            if len(data) > CANDIDATE_RECORD_LIMIT or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError(error)
        finally:
            os.close(descriptor)
    except OSError as failure:
        raise ValueError(error) from failure
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError(error)

    def unique_fields(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate candidate identity field')
            result[key] = value
        return result

    identity = json.loads(data, object_pairs_hook=unique_fields)
    fields = {'schemaVersion', 'name', 'version', 'sourceCommit', 'size', 'integrity', 'published'}
    if (not isinstance(identity, dict) or set(identity) != fields
            or type(identity['schemaVersion']) is not int or identity['schemaVersion'] != 1
            or identity['name'] != PAYLOAD or identity['version'] != CANDIDATE_VERSION
            or identity['published'] is not False
            or not isinstance(identity['sourceCommit'], str)
            or not re.fullmatch('[a-f0-9]{40}', identity['sourceCommit']) or set(identity['sourceCommit']) == {'0'}
            or type(identity['size']) is not int or not 0 < identity['size'] <= FROZEN_IOS['size']
            or not isinstance(identity['integrity'], str)
            or not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', identity['integrity'])):
        raise ValueError('Invalid frozen candidate iOS archive identity')
    encoded = identity['integrity'].removeprefix('sha512-')
    decoded = base64.b64decode(encoded, validate=True)
    if len(decoded) != 64 or base64.b64encode(decoded).decode() != encoded:
        raise ValueError('Noncanonical frozen candidate iOS archive integrity')
    return {**identity, 'identityRecordSha256': expected_sha256}


def ios_archive_identity(version, environment=None):
    if version == '0.2.0-beta.4':
        return FROZEN_IOS
    if version == '0.2.0-beta.5':
        return BETA5_IOS
    if version == CANDIDATE_VERSION:
        return candidate_ios_identity(environment)
    raise ValueError('No reviewed iOS archive identity for version: ' + version)


def verify_archives(root, wrapper_archive, ios_archive, arm_archive, x64_archive, limit=LIMIT, frozen_ios=None, environment=None):
    owner = json.loads((root / 'package.json').read_text())
    candidate = owner['version'] == CANDIDATE_VERSION
    if candidate and frozen_ios is not None:
        raise ValueError('Candidate iOS expected identity must come from the external frozen record')
    if frozen_ios is None:
        frozen_ios = ios_archive_identity(owner['version'], environment)
    if candidate:
        if (ios_archive.is_symlink() or not ios_archive.is_file()
                or ios_archive.stat().st_size != frozen_ios['size']
                or 'sha512-' + base64.b64encode(digest_file(ios_archive, 'sha512').digest()).decode() != frozen_ios['integrity']):
            raise ValueError('Reviewed candidate iOS archive bytes changed')
    expected_manifest = (root / '.utexo-native-overlay.json').read_bytes()
    expected_runtime = (root / 'runtime-contract.json').read_bytes()
    manifest = json.loads(expected_manifest)
    archives = [wrapper_archive, ios_archive, arm_archive, x64_archive]
    budgets = [limit, frozen_ios['size'], limit, limit]
    contents = [members(archive, budget) for archive, budget in zip(archives, budgets)]
    packages = [json.loads(content['package/package.json']['bytes']) for content in contents]
    wrapper = packages[0]
    if wrapper != owner or wrapper.get('name') != OWNER:
        raise ValueError('Packed wrapper metadata differs from reviewed source')
    if any(wrapper.get('dependencies', {}).get(payload['name']) != owner['version'] or any(payload['name'] in wrapper.get(field, {}) for field in ('optionalDependencies', 'peerDependencies', 'devDependencies')) for payload in PAYLOADS):
        raise ValueError('Payloads must be required exact-version dependencies')
    if any(name.startswith(('package/native/', 'package/node_modules/', 'package/.git/')) or name.endswith(('.a', '.tgz', '.pyc', '.log')) or name in ('package/package-lock.json', 'package/.git') for name in contents[0]):
        raise ValueError('Wrapper contains workspace, dependency or static archive data')
    if set(contents[0]) != wrapper_inventory(root, owner):
        raise ValueError('Wrapper archive inventory differs from reviewed source allowlist')
    for name, member in contents[0].items():
        relative = name.removeprefix('package/')
        verify_source_member(root / relative, member, 'wrapper source file: ' + relative)
    forbidden = ('scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'os', 'cpu', 'libc', 'main', 'bin', 'addon', 'workspaces')
    for descriptor, package, content in zip(PAYLOADS, packages[1:], contents[1:]):
        payload_root = root / descriptor['directory']
        if package != json.loads((payload_root / 'package.json').read_text()) or package.get('name') != descriptor['name'] or package.get('version') != owner['version']:
            raise ValueError('Packed payload metadata differs from reviewed source: ' + descriptor['name'])
        if package.get('utexoNativeOverlay') != owner['utexoNativeOverlay']:
            raise ValueError('Payload native graph mismatch: ' + descriptor['name'])
        if package.get('utexoNativePayload') != {'schemaVersion': 1, 'owner': OWNER, 'targets': list(descriptor['targets'])}:
            raise ValueError('Payload target metadata mismatch: ' + descriptor['name'])
        if any(field in package for field in forbidden) or package.get('exports') != {'./package.json': './package.json'}:
            raise ValueError('Payload is not portable data-only metadata: ' + descriptor['name'])
        allowed = {'package/package.json', 'package/LICENSE', 'package/README.md', 'package/.utexo-native-overlay.json', 'package/runtime-contract.json'} | {'package/prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare' for target in descriptor['targets']}
        if set(content) != allowed:
            raise ValueError('Unexpected payload archive member: ' + descriptor['name'])
        for name, member in content.items():
            source = payload_root / name.removeprefix('package/')
            verify_source_member(source, member, 'payload source file: ' + name)
    for content in contents:
        if content['package/.utexo-native-overlay.json']['bytes'] != expected_manifest or content['package/runtime-contract.json']['bytes'] != expected_runtime:
            raise ValueError('Packed native manifest/runtime contract changed')
    for name in FINGERPRINT_FILES:
        if contents[0]['package/' + name]['sha256'] != digest_file(root / name).hexdigest():
            raise ValueError('Native wrapper/build input changed: ' + name)
    assigned = []
    groups = (WRAPPER,) + tuple(payload['targets'] for payload in PAYLOADS)
    for content, targets in zip(contents, groups):
        expected = {'package/prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare' for target in targets}
        actual = {name for name in content if name.startswith('package/prebuilds/')}
        if actual != expected:
            raise ValueError('Native target partition mismatch')
        for target in targets:
            member = content['package/prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare']
            source = root / 'prebuilds' / target / 'utexo__rgb-lightning-node-bare.bare'
            if not member['size'] or member['sha256'] != manifest['artifacts'][target]['prebuildSha256'] or member['size'] != source.stat().st_size:
                raise ValueError('Original native bytes changed: ' + target)
            assigned.append({'target': target, 'sha256': member['sha256'], 'bytes': member['size']})
    if len(assigned) != 7 or len({value['target'] for value in assigned}) != 7:
        raise ValueError('The archive union must contain all seven original targets once')
    receipts = []
    for index, (archive, package, budget) in enumerate(zip(archives, packages, budgets)):
        integrity = 'sha512-' + base64.b64encode(digest_file(archive, 'sha512').digest()).decode()
        if index == 1 and (archive.stat().st_size != frozen_ios['size'] or integrity != frozen_ios['integrity']):
            label = 'Immutable published' if frozen_ios.get('published', True) else 'Reviewed candidate'
            raise ValueError(label + ' iOS archive bytes changed')
        receipts.append({'name': package['name'], 'version': package['version'], 'path': str(archive.resolve()), 'bytes': archive.stat().st_size, 'sha256': digest_file(archive).hexdigest(), 'integrity': integrity, 'maximumBytes': budget, 'immutableExistingPublication': index == 1 and frozen_ios.get('published', True)})
    result = {'archives': receipts, 'originalNativeTargets': assigned, 'nativeFingerprintsUnchanged': True, 'allSevenAssignedExactlyOnce': True, 'iosPublicationSourceCommit': frozen_ios['sourceCommit'] if frozen_ios.get('published', True) else None, 'publicationPerformed': False}
    if candidate:
        result['iosCandidateIdentity'] = {key: frozen_ios[key] for key in ('name', 'version', 'sourceCommit', 'size', 'integrity', 'published', 'identityRecordSha256')}
    return result


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit('usage: verify-distribution-archives.py WRAPPER.tgz IOS.tgz ANDROID_ARM.tgz ANDROID_X64.tgz')
    root = pathlib.Path(__file__).resolve().parent.parent
    # Fail on a missing candidate policy before invoking the native artifact gate.
    ios_archive_identity(json.loads((root / 'package.json').read_text())['version'])
    subprocess.run(['node', str(root / 'scripts/verify-distribution-artifacts.js')], check=True, stdout=sys.stderr)
    print(json.dumps(verify_archives(root, *(pathlib.Path(value) for value in sys.argv[1:])), indent=2))
