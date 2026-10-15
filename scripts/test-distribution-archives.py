#!/usr/bin/env python3
"""Small public fixtures exercise archive rejection without copying native binaries."""
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('distribution_archives', pathlib.Path(__file__).with_name('verify-distribution-archives.py'))
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='bare-archive-policy-')
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.ios = self.root / 'native' / 'ios'
        owner = {'name': GATE.OWNER, 'version': '0.2.0-beta.4', 'dependencies': {GATE.PAYLOAD: '0.2.0-beta.4'}, 'utexoNativeOverlay': {'fixture': True}, 'files': ['prebuilds/' + target + '/' for target in GATE.WRAPPER] + list(GATE.FINGERPRINT_FILES) + ['.utexo-native-overlay.json', 'runtime-contract.json']}
        payload = {'name': GATE.PAYLOAD, 'version': owner['version'], 'utexoNativeOverlay': owner['utexoNativeOverlay'], 'utexoNativePayload': {'schemaVersion': 1, 'owner': GATE.OWNER, 'targets': list(GATE.IOS)}, 'exports': {'./package.json': './package.json'}}
        self.write(self.root / 'package.json', json.dumps(owner).encode())
        self.write(self.ios / 'package.json', json.dumps(payload).encode())
        manifest = {'artifacts': {}}
        for target in GATE.WRAPPER + GATE.IOS:
            relative = 'prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare'
            data = ('Public non-native archive fixture: ' + target).encode()
            self.write(self.root / relative, data)
            if target in GATE.IOS:
                self.write(self.ios / relative, data)
            manifest['artifacts'][target] = {'prebuildSha256': hashlib.sha256(data).hexdigest()}
        for base in (self.root, self.ios):
            for name, data in {'README.md': b'Public fixture', 'LICENSE': b'Apache-2.0', 'runtime-contract.json': b'{"fixture":true}', '.utexo-native-overlay.json': json.dumps(manifest).encode()}.items():
                self.write(base / name, data)
        for name in GATE.FINGERPRINT_FILES:
            self.write(self.root / name, ('Public source fixture: ' + name).encode())
        self.wrapper_members = {'package/' + path.relative_to(self.root).as_posix(): path.read_bytes() for path in self.root.rglob('*') if path.is_file() and self.ios not in path.parents and not any(path == self.root / 'prebuilds' / target / 'utexo__rgb-lightning-node-bare.bare' for target in GATE.IOS)}
        self.ios_members = {'package/' + path.relative_to(self.ios).as_posix(): path.read_bytes() for path in self.ios.rglob('*') if path.is_file()}
        self.wrapper_archive = self.root / 'wrapper.tgz'
        self.ios_archive = self.root / 'ios.tgz'

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

    def verify(self, **options):
        self.archive(self.wrapper_archive, self.wrapper_members)
        self.archive(self.ios_archive, self.ios_members)
        return GATE.verify_archives(self.root, self.wrapper_archive, self.ios_archive, **options)

    def test_seven_original_targets_once(self):
        result = self.verify()
        self.assertTrue(result['allSevenAssignedExactlyOnce'])
        self.assertEqual(len(result['originalNativeTargets']), 7)
        self.assertFalse(result['publicationPerformed'])

    def test_corrupt_native_bytes(self):
        name = 'package/prebuilds/ios-x64-simulator/utexo__rgb-lightning-node-bare.bare'
        self.ios_members[name] += b'tampered'
        with self.assertRaisesRegex(ValueError, 'changed payload source'):
            self.verify()

    def test_missing_ios_target(self):
        del self.ios_members['package/prebuilds/ios-arm64/utexo__rgb-lightning-node-bare.bare']
        with self.assertRaisesRegex(ValueError, 'Unexpected payload archive member'):
            self.verify()

    def test_missing_wrapper_target(self):
        del self.wrapper_members['package/prebuilds/android-arm/utexo__rgb-lightning-node-bare.bare']
        with self.assertRaisesRegex(ValueError, 'Native target partition mismatch'):
            self.verify()

    def test_size_limit(self):
        with self.assertRaisesRegex(ValueError, 'exceeds 210 MiB'):
            self.verify(limit=1)

    def test_payload_executable_member(self):
        self.ios_members['package/index.js'] = b'process.exit()'
        with self.assertRaisesRegex(ValueError, 'Unexpected payload archive member'):
            self.verify()

    def test_wrapper_workspace_leak(self):
        self.wrapper_members['package/native/ios/package.json'] = b'{}'
        with self.assertRaisesRegex(ValueError, 'contains workspace'):
            self.verify()

    def test_payload_dependency_rejected_even_if_source_matches(self):
        data = json.loads(self.ios_members['package/package.json'])
        data['dependencies'] = {'unreviewed': '1.0.0'}
        encoded = json.dumps(data).encode()
        self.ios_members['package/package.json'] = encoded
        self.write(self.ios / 'package.json', encoded)
        with self.assertRaisesRegex(ValueError, 'not portable data-only'):
            self.verify()

    def test_optional_payload_is_not_required(self):
        data = json.loads(self.wrapper_members['package/package.json'])
        data['optionalDependencies'] = data.pop('dependencies')
        encoded = json.dumps(data).encode()
        self.wrapper_members['package/package.json'] = encoded
        self.write(self.root / 'package.json', encoded)
        with self.assertRaisesRegex(ValueError, 'required exact-version'):
            self.verify()

    def test_duplicate_path(self):
        name, data = next(iter(self.wrapper_members.items()))
        self.archive(self.wrapper_archive, self.wrapper_members, [(name, data)])
        with self.assertRaisesRegex(ValueError, 'duplicate archive member'):
            GATE.members(self.wrapper_archive, GATE.LIMIT)

    def test_path_traversal(self):
        self.archive(self.wrapper_archive, {'package/../outside': b'no'})
        with self.assertRaisesRegex(ValueError, 'Unexpected or duplicate'):
            GATE.members(self.wrapper_archive, GATE.LIMIT)

    def test_symlink_rejected(self):
        with tarfile.open(self.wrapper_archive, 'w:gz') as archive:
            member = tarfile.TarInfo('package/symlink')
            member.type = tarfile.SYMTYPE
            member.linkname = '/outside'
            archive.addfile(member)
        with self.assertRaisesRegex(ValueError, 'Unexpected or duplicate'):
            GATE.members(self.wrapper_archive, GATE.LIMIT)


if __name__ == '__main__':
    unittest.main()
