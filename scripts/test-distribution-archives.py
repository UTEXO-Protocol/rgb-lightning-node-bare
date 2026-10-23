#!/usr/bin/env python3
"""Public non-native fixtures exercise four-package admission and refusal."""
import base64
import hashlib
import importlib.util
import io
import json
import os
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
        for version in ('0.2.0-beta.6', '0.2.0-bfa.0'):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, 'No reviewed iOS archive identity'):
                GATE.ios_archive_identity(version)

    def test_current_candidate_version_matches_package_and_workspace_locks(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        owner = json.loads((root / 'package.json').read_text())
        lock = json.loads((root / 'package-lock.json').read_text())
        self.assertEqual(owner['version'], GATE.CANDIDATE_VERSION)
        self.assertEqual(lock['version'], owner['version'])
        self.assertEqual(lock['packages']['']['version'], owner['version'])
        for payload in GATE.PAYLOADS:
            metadata = json.loads((root / payload['directory'] / 'package.json').read_text())
            self.assertEqual(metadata['version'], owner['version'])
            self.assertEqual(owner['dependencies'][payload['name']], owner['version'])
            self.assertEqual(lock['packages']['']['dependencies'][payload['name']], owner['version'])
            self.assertEqual(lock['packages'][payload['directory']]['version'], owner['version'])
            self.assertEqual((root / payload['directory'] / 'runtime-contract.json').read_bytes(),
                             (root / 'runtime-contract.json').read_bytes())

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
        # Source fixtures model Git checkout modes, independent of a maintainer's
        # restrictive umask. Permission-corruption tests override this explicitly.
        file.chmod(0o644)

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
        # Published CLI paths retain reviewed version SRI. Candidate CLI paths
        # require a separate frozen record, never this direct test injection.
        frozen = {'size': self.archives[1].stat().st_size, 'integrity': frozen_integrity or 'sha512-' + base64.b64encode(GATE.digest_file(self.archives[1], 'sha512').digest()).decode(), 'sourceCommit': 'SYNTHETIC-UNIT-FIXTURE-NOT-A-LIVE-PACKAGE'}
        return GATE.verify_archives(self.root, *self.archives, frozen_ios=frozen, **options)

    def candidate_record(self):
        # Frozen public non-native fixture only. Production never creates this
        # expected identity from the archive currently undergoing qualification.
        for index, base in enumerate([self.root] + [self.root / p['directory'] for p in GATE.PAYLOADS]):
            metadata = json.loads(self.contents[index]['package/package.json'])
            metadata['version'] = GATE.CANDIDATE_VERSION
            if index == 0:
                metadata['dependencies'] = {p['name']: GATE.CANDIDATE_VERSION for p in GATE.PAYLOADS}
            data = json.dumps(metadata).encode()
            self.contents[index]['package/package.json'] = data
            self.write(base / 'package.json', data)
        for archive, content in zip(self.archives, self.contents):
            self.archive(archive, content)
        record = {'schemaVersion': 1, 'name': GATE.PAYLOAD, 'version': GATE.CANDIDATE_VERSION,
                  'sourceCommit': 'a' * 40, 'size': self.archives[1].stat().st_size,
                  'integrity': 'sha512-' + base64.b64encode(GATE.digest_file(self.archives[1], 'sha512').digest()).decode(),
                  'published': False}
        file = self.root / 'candidate-ios-identity.json'
        environment = {GATE.CANDIDATE_IDENTITY_ENV: str(file), GATE.CANDIDATE_IDENTITY_SHA256_ENV: ''}
        def seal():
            data = json.dumps(record).encode()
            file.write_bytes(data)
            environment[GATE.CANDIDATE_IDENTITY_SHA256_ENV] = hashlib.sha256(data).hexdigest()
        seal()
        return record, file, environment, seal

    def test_candidate_frozen_external_record_preserves_all_seven_target_checks_without_publication(self):
        record, _, environment, _ = self.candidate_record()
        result = GATE.verify_archives(self.root, *self.archives, environment=environment)
        self.assertEqual(len(result['originalNativeTargets']), 7)
        self.assertTrue(result['allSevenAssignedExactlyOnce'])
        self.assertFalse(result['archives'][1]['immutableExistingPublication'])
        self.assertFalse(result['publicationPerformed'])
        self.assertIsNone(result['iosPublicationSourceCommit'])
        self.assertEqual(result['iosCandidateIdentity'], {**{key: record[key] for key in record if key != 'schemaVersion'},
                                                         'identityRecordSha256': environment[GATE.CANDIDATE_IDENTITY_SHA256_ENV]})
        target = GATE.PAYLOADS[2]['targets'][0]
        del self.contents[3]['package/prebuilds/' + target + '/utexo__rgb-lightning-node-bare.bare']
        self.archive(self.archives[3], self.contents[3])
        with self.assertRaisesRegex(ValueError, 'Unexpected payload archive member'):
            GATE.verify_archives(self.root, *self.archives, environment=environment)

    def test_candidate_has_no_implicit_or_direct_injection_fallback(self):
        record, _, environment, _ = self.candidate_record()
        for values in ({}, {GATE.CANDIDATE_IDENTITY_ENV: environment[GATE.CANDIDATE_IDENTITY_ENV]},
                       {GATE.CANDIDATE_IDENTITY_SHA256_ENV: environment[GATE.CANDIDATE_IDENTITY_SHA256_ENV]}):
            with self.subTest(environment=values), self.assertRaisesRegex(ValueError, 'independently frozen'):
                GATE.verify_archives(self.root, *self.archives, environment=values)
        with self.assertRaisesRegex(ValueError, 'external frozen record'):
            GATE.verify_archives(self.root, *self.archives, frozen_ios=record, environment=environment)

    def test_candidate_record_cannot_change_published_archive_policy(self):
        _, _, environment, _ = self.candidate_record()
        environment[GATE.CANDIDATE_IDENTITY_SHA256_ENV] = 'wrong'
        self.assertIs(GATE.ios_archive_identity('0.2.0-beta.4', environment), GATE.FROZEN_IOS)
        self.assertIs(GATE.ios_archive_identity('0.2.0-beta.5', environment), GATE.BETA5_IOS)

    def test_candidate_record_fields_are_exact_and_bounded(self):
        record, _, environment, seal = self.candidate_record()
        variants = [
            ('schemaVersion', True), ('schemaVersion', 2), ('name', GATE.OWNER), ('version', '0.2.0-beta.5'),
            ('version', '0.2.0-bfa.0'),
            ('sourceCommit', 'main'), ('sourceCommit', 'a' * 39), ('sourceCommit', '0' * 40),
            ('size', True), ('size', 0), ('size', -1), ('size', 1.1), ('size', GATE.FROZEN_IOS['size'] + 1),
            ('published', True), ('published', 0), ('published', 'false'), ('integrity', 'sha512-AAAA'),
            ('integrity', 'sha512-' + 'A' * 85 + 'B=='), ('unused', 'unreviewed')]
        for key, value in variants:
            with self.subTest(field=key, value=value):
                before = dict(record)
                record[key] = value
                seal()
                with self.assertRaises(ValueError):
                    GATE.ios_archive_identity(GATE.CANDIDATE_VERSION, environment)
                record.clear()
                record.update(before)
        seal()
        record['size'] = GATE.FROZEN_IOS['size']
        seal()
        self.assertEqual(GATE.ios_archive_identity(GATE.CANDIDATE_VERSION, environment)['size'], GATE.FROZEN_IOS['size'])

    def test_candidate_record_rejects_unpinned_paths_links_duplicate_fields_and_oversized_metadata(self):
        _, file, environment, _ = self.candidate_record()
        original = file.read_bytes()
        for kind in ('wrong-digest', 'relative-path', 'directory', 'symlink', 'fifo', 'oversized', 'duplicate-field'):
            with self.subTest(kind=kind):
                values = dict(environment)
                file.write_bytes(original)
                if kind == 'wrong-digest':
                    values[GATE.CANDIDATE_IDENTITY_SHA256_ENV] = '0' * 64
                if kind == 'relative-path':
                    values[GATE.CANDIDATE_IDENTITY_ENV] = file.name
                if kind == 'directory':
                    values[GATE.CANDIDATE_IDENTITY_ENV] = str(self.root)
                if kind == 'symlink':
                    alias = self.root / 'identity-link.json'
                    alias.symlink_to(file)
                    values[GATE.CANDIDATE_IDENTITY_ENV] = str(alias)
                if kind == 'fifo':
                    fifo = self.root / 'identity-fifo'
                    os.mkfifo(fifo)
                    values[GATE.CANDIDATE_IDENTITY_ENV] = str(fifo)
                if kind in ('oversized', 'duplicate-field'):
                    data = b' ' * (GATE.CANDIDATE_RECORD_LIMIT + 1) if kind == 'oversized' else original[:-1] + b', "published":false}'
                    file.write_bytes(data)
                    values[GATE.CANDIDATE_IDENTITY_SHA256_ENV] = hashlib.sha256(data).hexdigest()
                with self.assertRaises(ValueError):
                    GATE.ios_archive_identity(GATE.CANDIDATE_VERSION, values)

    def test_candidate_frozen_bytes_are_not_reblessed_when_archive_changes(self):
        _, _, environment, _ = self.candidate_record()
        with self.archives[1].open('ab') as file:
            file.write(b'\0')
        with self.assertRaisesRegex(ValueError, 'Reviewed candidate iOS archive bytes changed'):
            GATE.verify_archives(self.root, *self.archives, environment=environment)

    def test_candidate_ios_archive_cannot_be_a_symlink(self):
        _, _, environment, _ = self.candidate_record()
        source = self.archives[1].with_suffix('.original.tgz')
        self.archives[1].rename(source)
        self.archives[1].symlink_to(source)
        with self.assertRaisesRegex(ValueError, 'Reviewed candidate iOS archive bytes changed'):
            GATE.verify_archives(self.root, *self.archives, environment=environment)

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
