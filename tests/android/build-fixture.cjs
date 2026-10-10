'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { sha256, BARE_KIT } = require('../../scripts/stage-android-addons')

if (process.argv.length !== 5) throw new Error('Usage: node build-fixture.cjs STAGED BARE_KIT NEW_OUTPUT')
const [stage, kit, output] = process.argv.slice(2).map(value => path.resolve(value))
if (fs.existsSync(output)) throw new Error('Fixture output must be a new directory')
const sdk = process.env.ANDROID_HOME || path.join(process.env.HOME, 'Library/Android/sdk')
const ndk = process.env.ANDROID_NDK_HOME || path.join(sdk, 'ndk/27.1.12297006')
const host = fs.readdirSync(path.join(ndk, 'toolchains/llvm/prebuilt'))
if (host.length !== 1) throw new Error('Ambiguous NDK')
const llvm = path.join(ndk, 'toolchains/llvm/prebuilt', host[0])
const build = path.join(sdk, 'build-tools/36.0.0')
const androidJar = path.join(sdk, 'platforms/android-36/android.jar')
const kitJar = path.join(kit, 'android/libs/bare-kit/classes.jar')
const run = (bin, args, cwd = output) => execFileSync(bin, args, { cwd, stdio: 'inherit' })
fs.mkdirSync(output, { recursive: true })
for (const dir of ['classes', 'dex', 'assets']) fs.mkdirSync(path.join(output, dir))
const packManifest = require.resolve('bare-pack/package')
const packBin = path.join(path.dirname(packManifest), require(packManifest).bin['bare-pack'])
run(process.execPath, [packBin, '--linked', '--base', path.resolve(__dirname, '../..'),
  '--host', 'android-arm64', '--host', 'android-arm', '--host', 'android-x64',
  '--out', path.join(output, 'assets/canary.bundle'), path.join(__dirname, 'canary.js')])
const targets = { 'arm64-v8a': ['aarch64-linux-android', 'aarch64-linux-android29-clang'],
  'armeabi-v7a': ['arm-linux-androideabi', 'armv7a-linux-androideabi29-clang'],
  x86_64: ['x86_64-linux-android', 'x86_64-linux-android29-clang'] }
const expected = {}
for (const [abi, [triple, compiler]] of Object.entries(targets)) {
  const dir = path.join(output, 'lib', abi)
  fs.mkdirSync(dir, { recursive: true })
  for (const entry of fs.readdirSync(path.join(stage, abi))) {
    const source = path.join(stage, abi, entry)
    fs.copyFileSync(source, path.join(dir, entry))
    expected[`lib/${abi}/${entry}`] = sha256(source)
  }
  const runtime = path.join(kit, 'android/libs/bare-kit/jni', abi, 'libbare-kit.so')
  if (sha256(runtime) !== BARE_KIT.runtimeSha256[abi]) throw new Error('Unreviewed runtime')
  fs.copyFileSync(runtime, path.join(dir, 'libbare-kit.so'))
  fs.copyFileSync(path.join(llvm, 'sysroot/usr/lib', triple, 'libc++_shared.so'), path.join(dir, 'libc++_shared.so'))
  run(path.join(llvm, 'bin', compiler), ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', '-Wl,-z,relro,-z,now,-z,max-page-size=16384,-z,common-page-size=16384',
    path.join(__dirname, 'protection.c'), '-ldl', '-o', path.join(dir, 'libqualification.so')])
}
run('javac', ['--release', '11', '-cp', `${androidJar}${path.delimiter}${kitJar}`, '-d', 'classes', path.join(__dirname, 'Runner.java')])
run('jar', ['cf', 'fixture.jar', '-C', 'classes', '.'])
run(path.join(build, 'd8'), ['--min-api', '29', '--lib', androidJar, '--output', 'dex', 'fixture.jar', kitJar])
run(path.join(build, 'aapt2'), ['link', '-o', 'unsigned.apk', '-I', androidJar, '--manifest', path.join(__dirname, 'AndroidManifest.xml'), '-A', 'assets'])
fs.copyFileSync(path.join(output, 'dex/classes.dex'), path.join(output, 'classes.dex'))
run('zip', ['-q', '-0', '-r', 'unsigned.apk', 'classes.dex', 'lib'])
run(path.join(build, 'zipalign'), ['-P', '16', '-f', '4', 'unsigned.apk', 'aligned.apk'])
run('keytool', ['-genkeypair', '-keystore', 'fixture.jks', '-storepass', 'android', '-keypass', 'android', '-alias', 'fixture',
  '-dname', 'CN=Disposable Android Packaging Test', '-keyalg', 'RSA', '-validity', '365', '-noprompt'])
run(path.join(build, 'apksigner'), ['sign', '--ks', 'fixture.jks', '--ks-pass', 'pass:android', '--out', 'qualification.apk', 'aligned.apk'])
run(path.join(build, 'apksigner'), ['verify', '--verbose', 'qualification.apk'])
run(path.join(build, 'zipalign'), ['-c', '-P', '16', '4', 'qualification.apk'])
for (const [entry, digest] of Object.entries(expected)) {
  const bytes = execFileSync('unzip', ['-p', path.join(output, 'qualification.apk'), entry], { maxBuffer: 512 * 1024 * 1024 })
  if (require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`APK changed ${entry}`)
}
fs.writeFileSync(path.join(output, 'package-evidence.json'), JSON.stringify({ apkSha256: sha256(path.join(output, 'qualification.apk')), stagedFiles: expected }, null, 2) + '\n')
for (const file of ['unsigned.apk', 'aligned.apk']) fs.unlinkSync(path.join(output, file))
fs.rmSync(path.join(output, 'lib'), { recursive: true })
console.log('APK signature, 16-KiB ZIP alignment and exact staged payloads verified; emulator execution is separate.')
