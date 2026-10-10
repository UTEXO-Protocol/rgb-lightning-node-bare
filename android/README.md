# Android packaging

Use the package's staging hook with `react-native-bare-kit@0.15.5` and NDK
`27.1.12297006`. It supports `arm64-v8a`, `armeabi-v7a` and `x86_64`; x86 is not
a published RLN target. The 64-bit payloads retain their original 16-KiB layout.

`bare-link@3.3.2` with `bare-lief@0.2.9` or `0.2.10` rewrites this addon's ELF
layout, misaligning RELRO and moving DYNAMIC outside it. The staging step does
not repair that rewritten binary. It verifies the original prebuild and copies
it byte-for-byte under the filename used by Bare's `linked:` resolver.
No upstream fork, weakened ELF check or Rust rebuild is required.

## React Native setup

Install the matching release native package, keep its provenance file, and pin
`react-native-bare-kit` to `0.15.5`. Do not combine this hook with another RLN
staging hook. Existing Iris-specific staging must be removed when adopting it.

In `android/gradle.properties`, select only supported ABIs:

```properties
reactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64
```

In the root `android/build.gradle`, after the root plugins are applied:

```groovy
def rlnBareManifest = providers.exec {
    workingDir rootDir.parentFile
    commandLine 'node', '--print', "require.resolve('@utexo/rgb-lightning-node-bare/package.json')"
}.standardOutput.asText.get().trim()
ext.utexoBarePackageDir = new File(rlnBareManifest).parentFile
apply from: new File(utexoBarePackageDir, 'android/staging.gradle')
```

Set `ANDROID_NDK_HOME` to the pinned NDK when it is not in the standard SDK
location. `-PutexoBareNodeBinary=/absolute/path/to/node` selects the Node
executable used by staging. Node 20 or later is required.

The task order is `bare-link -> stageUtexoBareAddons -> JNI merge`. Only the
addon JNI source directory is replaced. BareKit's own runtime directory and
Java/JAR inputs are retained. The task revalidates every build and does not edit
installed dependencies or the original linker output.

## Explicit staging

Other build orchestration can invoke the same verifier. The runtime package
must still be the reviewed BareKit version above, and its runtime hashes must
match. Package the generated tree instead of the raw linked-addon directory.

```sh
node node_modules/@utexo/rgb-lightning-node-bare/scripts/stage-android-addons.js \
  --bare-kit node_modules/react-native-bare-kit \
  --linked-dir path/to/bare-link-output \
  --out android/build/generated/utexo-bare-addons \
  --abis arm64-v8a,armeabi-v7a,x86_64
```

The output must be a new directory or a previous output owned by this tool.
Unrelated files, symlinks, source/output overlap, stale RLN versions and native
addons depending on RLN are rejected. Other linked addons are copied unchanged.

## What is verified

- Release source, adapter, wrapper and prebuild hashes using the package's
  existing provenance contract.
- ABI, LOAD alignment, non-executable stack, RELRO/DYNAMIC/GOT protection,
  immediate binding, no text relocations/RPATH and retained Rust TLS code.
- Every native import against the exact BareKit binary or the API-29 NDK
  system exports. The current RLN prebuild has system-only `DT_NEEDED` entries.
- No conflicting RLN SONAME or incoming native dependency. The original
  major-version SONAME is retained; native-to-RLN linking and multiple RLN
  versions in one process are outside this supported integration.
- Exact hashes after copying. A failed verification/copy preserves the previous
  output but fails the build; it is not permission to reuse stale output.

`utexo-android-staging.json` records the native identities, runtime hashes and
staged files. Verify the final APK/AAB payloads and 16-KiB ZIP alignment as well.
This packaging path does not qualify wallet recovery, TLS, or physical devices.

## Regression tests

`npm run test:installer` exercises the validators and failed-copy behavior.
Run the Gradle graph fixture with Gradle 9.3.1:

```sh
gradle -p tests/android-gradle --offline --no-daemon :app:mergeReleaseNativeLibs
```

The Android instrumentation fixture builds a disposable test-signed APK with
all three ABIs. It checks packaged byte equality, signatures and ZIP alignment.
Its three real BareKit worklets exercise the public JavaScript wrapper, native
dependencies, compiled identity, strict signer creation/bootstrap/destruction,
private storage permissions and teardown. A JNI probe checks
that RELRO and DYNAMIC are actually read-only in `/proc/self/maps`.
Building this fixture requires Node 22.21+ (or 24.9+), the locked dev dependencies,
JDK 17+, Android platform 36 and build-tools 36.0.0. This is a test-tooling floor,
not a change to the staging CLI's Node 20 minimum.

```sh
node tests/android/build-fixture.cjs STAGED_DIR BARE_KIT_DIR NEW_OUTPUT_DIR
adb -s EMULATOR install --no-incremental -t NEW_OUTPUT_DIR/qualification.apk
adb -s EMULATOR shell am instrument -w -e pageSize 16384 \
  com.utexo.linkqualification/.Runner
```

Use `pageSize 4096` on a 4-KiB emulator. Require the explicit `PASS` result,
three successful worklet results and `INSTRUMENTATION_CODE: -1`; adb's shell
exit status alone is not a test pass. Test source is in the repository, not the
runtime npm archive. The fixture uses public deterministic regtest keys and
must never be funded.
