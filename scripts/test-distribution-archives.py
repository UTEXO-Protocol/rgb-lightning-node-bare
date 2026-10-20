#!/usr/bin/env python3
"""Public non-native fixtures exercise four-package admission and refusal."""
import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import random
import subprocess
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('distribution_archives', pathlib.Path(__file__).with_name('verify-distribution-archives.py'))
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


class ArchiveTests(unittest.TestCase):
    def test_published_beta4_ios_identity_is_unchanged(self):
        identity = GATE.ios_archive_identity('0.2.0-beta.4')
        self.assertEqual(identity['size'], 146197231)
        self.assertEqual(identity['integrity'], 'sha512-BOfizU4fqvGyl4L2Q0YAikLEYGyOBDYQikYPPR7IgxnmKrddm3T1/Lv0YnQeYt1EsBOf2SGyLNJKOLaWOglrkg==')
        self.assertEqual(identity['sourceCommit'], '15b0ff68d1b59fa88131cfb9be6fe48c30287e6b')

    def test_beta5_ios_has_separate_reviewed_identity_without_larger_budget(self):
        identity = GATE.ios_archive_identity('0.2.0-beta.5')
        self.assertLessEqual(identity['size'], GATE.FROZEN_IOS['size'])
        self.assertEqual(identity['size'], 143638135)
        self.assertEqual(identity['integrity'], 'sha512-UdhulayuKoaHKaM/CkpRf2paetb8y4Mhaw58snFO+WALAo4Bgd5OqxbK8Pcae9Llu78xrrrOIs3hlxQoOXBUwA==')
        self.assertFalse(identity['published'])
        self.assertIsNone(identity['sourceCommit'])
        self.assertNotEqual(identity['integrity'], GATE.FROZEN_IOS['integrity'])

    def test_unreviewed_ios_version_has_no_legacy_fallback(self):
        with self.assertRaisesRegex(ValueError, 'No reviewed iOS archive identity'):
            GATE.ios_archive_identity('0.2.0-beta.6')

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='bare-archive-policy-')
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        owner = {'name': GATE.OWNER, 'version': '0.2.0-beta.4', 'dependencies': {p['name']: '0.2.0-beta.4' for p in GATE.PAYLOADS}, 'utexoNativeOverlay': {'fixture': True}, 'files': ['prebuilds/' + target + '/' for target in GATE.WRAPPER] + list(GATE.FINGERPRINT_FILES) + ['.utexo-native-overlay.json', 'runtime-contract.json']}
        self.write(self.root / 'package.json', json.dumps(owner).encode())
        groups = [GATE.WRAPPER] + [p['targets'] for p in GATE.PAYLOADS]
        bases = [self.root] + [self.root / p['directory'] for p in GATE.PAYLOADS]
        manifest = {'artifacts': {}}
        for descriptor, base in zip(GATE.PAYLOADS, bases[1:]):
            metadata = {'name': descriptor['name'], 'version': owner['version'], 'utexoNativeOverlay': owner['utexoNativeOverlay'], 'utexoNativePayload': {'schemaVersion': 1, 'owner': GATE.OWNER, 'targets': list(descriptor['targets'])}, 'exports': {'./package.json': './package.json'}}
            self.write(base / 'package.json', json.dumps(metadata).encode())
        for targets, base in zip(groups, bases):
            for target in targets:
                relative = 'prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare'
                data = ('Public non-native archive fixture: ' + target).encode()
                self.write(self.root / relative, data)
                self.write(base / relative, data)
                manifest['artifacts'][target] = {'prebuildSha256': hashlib.sha256(data).hexdigest()}
        for base in bases:
            for name, data in {'README.md': b'Public fixture', 'LICENSE': b'Apache-2.0', 'runtime-contract.json': b'{"fixture":true}', '.utexo-native-overlay.json': json.dumps(manifest).encode()}.items():
                self.write(base / name, data)
        for name in GATE.FINGERPRINT_FILES:
            self.write(self.root / name, ('Public source fixture: ' + name).encode())
        self.contents = []
        for index, base in enumerate(bases):
            data = {}
            for file in base.rglob('*'):
                if not file.is_file() or (index == 0 and self.root / 'native' in file.parents):
                    continue
                relative = file.relative_to(base).as_posix()
                if index == 0 and relative.startswith('prebuilds/') and not any(relative == 'prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare' for target in GATE.WRAPPER):
                    continue
                data['package/' + relative] = file.read_bytes()
            self.contents.append(data)
        self.archives = [self.root / (name + '.tgz') for name in ('wrapper', 'ios', 'arm', 'x64')]
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)

    def write(self, file, data):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)

    def archive(self, file, content, extras=()):
        with tarfile.open(file, 'w:gz') as archive:
            for name, data in list(content.items()) + list(extras):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = 0o644
                archive.addfile(member, io.BytesIO(data))

    def verify(self, frozen_integrity=None, **options):
        for archive, content in zip(self.archives, self.contents):
            self.archive(archive, content)
        # Only direct test calls inject a synthetic frozen iOS expectation.
        # Production CLI has no flag/env override and requires the reviewed version SRI.
        frozen = {'size': self.archives[1].stat().st_size, 'integrity': frozen_integrity or 'sha512-' + base64.b64encode(GATE.digest_file(self.archives[1], 'sha512').digest()).decode(), 'sourceCommit': 'SYNTHETIC-UNIT-FIXTURE-NOT-A-LIVE-PACKAGE'}
        return GATE.verify_archives(self.root, *self.archives, frozen_ios=frozen, **options)

    def test_seven_original_targets_once(self):
        result = self.verify()
        self.assertTrue(result['allSevenAssignedExactlyOnce'])
        self.assertEqual(len(result['originalNativeTargets']), 7)
        self.assertEqual(len(result['archives']), 4)
        self.assertTrue(result['archives'][1]['immutableExistingPublication'])
        self.assertFalse(result['publicationPerformed'])

    def test_each_corrupt_native_payload(self):
        for index, descriptor in enumerate(GATE.PAYLOADS, 1):
            with self.subTest(package=descriptor['name']):
                name = 'package/prebuilds/' + descriptor['targets'][-1] + '/utexo__rgb-lightning-node-bare.bare'
                before = self.contents[index][name]
                self.contents[index][name] += b'tampered'
                with self.assertRaisesRegex(ValueError, 'changed payload source'):
                    self.verify()
                self.contents[index][name] = before

    def test_each_missing_payload_target(self):
        for index, descriptor in enumerate(GATE.PAYLOADS, 1):
            with self.subTest(package=descriptor['name']):
                name = 'package/prebuilds/' + descriptor['targets'][0] + '/utexo__rgb-lightning-node-bare.bare'
                before = self.contents[index].pop(name)
                with self.assertRaisesRegex(ValueError, 'Unexpected payload archive member'):
                    self.verify()
                self.contents[index][name] = before

    def test_missing_wrapper_target(self):
        del self.contents[0]['package/prebuilds/darwin-arm64/utexo__rgb-lightning-node-bare.bare']
        with self.assertRaisesRegex(ValueError, 'Wrapper archive inventory'):
            self.verify()

    def test_every_installer_source_member_is_required(self):
        for name in GATE.FINGERPRINT_FILES:
            member = 'package/' + name
            before = self.contents[0].pop(member)
            with self.subTest(missing=name), self.assertRaisesRegex(ValueError, 'Wrapper archive inventory'):
                self.verify()
            self.contents[0][member] = before

    def test_new_helper_in_allowlist_cannot_be_silently_omitted(self):
        metadata = json.loads(self.contents[0]['package/package.json'])
        metadata['files'].append('scripts/')
        data = json.dumps(metadata).encode()
        self.contents[0]['package/package.json'] = data
        self.write(self.root / 'package.json', data)
        self.write(self.root / 'scripts/install-distribution.js', b'require("./native-distribution")')
        with self.assertRaisesRegex(ValueError, 'Wrapper archive inventory'):
            self.verify()

    def test_archive_executable_permission_is_not_source_permission(self):
        self.verify()
        name = 'package/index.js'
        original = GATE.members
        def changed_mode(archive, limit):
            result = original(archive, limit)
            if archive == self.archives[0]:
                result[name]['mode'] = 0o755
            return result
        GATE.members = changed_mode
        try:
            with self.assertRaisesRegex(ValueError, 'member mode'):
                self.verify()
        finally:
            GATE.members = original

    def test_size_limit(self):
        with self.assertRaisesRegex(ValueError, 'size budget'):
            self.verify(limit=1)

    def test_android_size_limit_independent_of_wrapper(self):
        name = 'package/README.md'
        data = random.Random(42).randbytes(32768)
        self.contents[2][name] = data
        self.write(self.root / GATE.PAYLOADS[1]['directory'] / 'README.md', data)
        with self.assertRaisesRegex(ValueError, 'size budget'):
            self.verify(limit=4096)

    def test_immutable_ios_sri_is_required_even_when_all_members_are_valid(self):
        with self.assertRaisesRegex(ValueError, 'Immutable published iOS archive bytes changed'):
            self.verify(frozen_integrity='sha512-AAAA')

    def test_each_payload_executable_member(self):
        for index, descriptor in enumerate(GATE.PAYLOADS, 1):
            with self.subTest(package=descriptor['name']):
                self.contents[index]['package/index.js'] = b'process.exit()'
                with self.assertRaisesRegex(ValueError, 'Unexpected payload archive member'):
                    self.verify()
                del self.contents[index]['package/index.js']

    def test_wrapper_workspace_leak(self):
        self.contents[0]['package/native/ios/package.json'] = b'{}'
        with self.assertRaisesRegex(ValueError, 'contains workspace'):
            self.verify()

    def test_each_payload_dependency_rejected_even_if_source_matches(self):
        for index, descriptor in enumerate(GATE.PAYLOADS, 1):
            with self.subTest(package=descriptor['name']):
                original = self.contents[index]['package/package.json']
                metadata = json.loads(original)
                metadata['dependencies'] = {'unreviewed': '1.0.0'}
                encoded = json.dumps(metadata).encode()
                self.contents[index]['package/package.json'] = encoded
                source = self.root / descriptor['directory'] / 'package.json'
                self.write(source, encoded)
                with self.assertRaisesRegex(ValueError, 'not portable data-only'):
                    self.verify()
                self.contents[index]['package/package.json'] = original
                self.write(source, original)

    def test_each_optional_payload_is_not_required(self):
        original = self.contents[0]['package/package.json']
        for descriptor in GATE.PAYLOADS:
            with self.subTest(package=descriptor['name']):
                metadata = json.loads(original)
                metadata['optionalDependencies'] = {descriptor['name']: metadata['dependencies'].pop(descriptor['name'])}
                encoded = json.dumps(metadata).encode()
                self.contents[0]['package/package.json'] = encoded
                self.write(self.root / 'package.json', encoded)
                with self.assertRaisesRegex(ValueError, 'required exact-version'):
                    self.verify()
        self.contents[0]['package/package.json'] = original
        self.write(self.root / 'package.json', original)

    def test_duplicate_path(self):
        name, data = next(iter(self.contents[0].items()))
        self.archive(self.archives[0], self.contents[0], [(name, data)])
        with self.assertRaisesRegex(ValueError, 'duplicate archive member'):
            GATE.members(self.archives[0], GATE.LIMIT)

    def test_path_traversal(self):
        self.archive(self.archives[0], {'package/../outside': b'no'})
        with self.assertRaisesRegex(ValueError, 'Unexpected or duplicate'):
            GATE.members(self.archives[0], GATE.LIMIT)

    def test_symlink_rejected(self):
        with tarfile.open(self.archives[0], 'w:gz') as archive:
            member = tarfile.TarInfo('package/symlink')
            member.type = tarfile.SYMTYPE
            member.linkname = '/outside'
            archive.addfile(member)
        with self.assertRaisesRegex(ValueError, 'Unexpected or duplicate'):
            GATE.members(self.archives[0], GATE.LIMIT)


if __name__ == '__main__':
    unittest.main()
