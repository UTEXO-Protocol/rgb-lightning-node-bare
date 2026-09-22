/**
 * @utexo/rgb-lightning-node-bare — JS façade for the rgb-lightning-node C-FFI.
 *
 * Wraps the released SdkNode C-FFI surface. JSON methods are parsed/stringified
 * here; compatibility stubs for excluded overlays fail before native access.
 *
 * Two seed-handling modes:
 *
 *   1. Password / mnemonic (legacy — RLN owns the seed, encrypts on disk):
 *        const node = SdkNode.create({ ...JsonSdkInitRequest })
 *        node.init('password', mnemonic)                // optional mnemonic
 *        node.unlock({ ...JsonSdkUnlockRequest })       // includes password
 *
 *   2. External signer (WDK-style — host owns the seed):
 *        const node = SdkNode.create({ ...JsonSdkInitRequest })
 *        const signer = NativeExternalSigner.create(seedHex, network)
 *        try { node.initWithNativeExternalSigner(signer) }
 *        catch (e) { if (!String(e.message).includes('Conflict')) throw e }
 *        node.unlockWithNativeExternalSigner(signer, { ...rpcArgs })
 *
 * The GC destructor of `SdkNode` calls `rln_sdk_node_shutdown` +
 * `free_sdk_node` automatically, but explicit `shutdown()` is preferred
 * so resources release deterministically. The signer's GC destructor
 * drops its `Arc` ref; RLN holds its own clone post-attach so the JS
 * handle is safe to drop early.
 */

const binding = require('./binding')
const { parse, stringify, paymentRequest, unsupported, UnsupportedCapabilityError } = require('./json-boundary')
const expectedRuntime = require('./runtime-contract.json')
const runtimeInfo = parse(binding.getRuntimeInfo())
for (const [key, expected] of Object.entries(expectedRuntime)) {
  if (runtimeInfo[key] !== expected) throw new Error(`Native artifact identity mismatch: ${key}; rebuild the package`)
}
Object.freeze(runtimeInfo.capabilities)
Object.freeze(runtimeInfo)
exports.getRuntimeInfo = () => runtimeInfo
exports.UnsupportedCapabilityError = UnsupportedCapabilityError

// Module-level helpers (no SdkNode handle)

exports.uniffiHealthcheck = function () {
  return binding.uniffiHealthcheck()
}

exports.uniffiIsInitialized = function () {
  // Native returns "true" / "false" string — convert.
  return binding.uniffiIsInitialized() === 'true'
}

exports.sdkInitialize = function (request) {
  return binding.sdkInitialize(stringify(request))
}

exports.sdkShutdown = function () {
  return binding.sdkShutdown()
}

class SdkNode {
  constructor (handle) {
    this._handle = handle
    this._closed = false
  }

  static create (request) {
    return new SdkNode(binding.sdkNodeNew(stringify(request)))
  }

  // -------- Lifecycle --------

  // Returns the mnemonic (whether passed in or freshly generated).
  init (password, mnemonic) {
    return binding.sdkNodeInit(this._handle, password, mnemonic ?? null)
  }

  unlock (request) {
    binding.sdkNodeUnlock(this._handle, stringify(request))
  }

  shutdown () {
    if (this._closed) return
    binding.sdkNodeShutdown(this._handle)
    binding.sdkNodeDestroy(this._handle)
    this._handle = null
    this._closed = true
  }

  /**
   * Forces takeover of a stale VSS ownership fence after the previous
   * node died holding it. Throws `Rln(FailedVssInit)` if VSS isn't
   * configured. Pointing two live nodes at the same VSS store corrupts
   * state — call only when certain the previous owner is gone.
   *
   * @param {{ password: string }} request
   */
  vssClearFence (request) {
    binding.sdkNodeVssClearFence(this._handle, stringify(request))
  }

  /**
   * Force an immediate VSS backup flush. Returns `{ version }` where
   * version is the snapshot index just persisted. Throws if VSS isn't
   * configured (no `vssUrl` at init) or the flush fails (server
   * unreachable, auth rejected). Useful for app-controlled
   * checkpoints (e.g. "save state before app suspend") rather than
   * relying on the implicit on-write flush.
   *
   * Backed by the released `vss_backup()` C-FFI method.
   *
   * @returns {{version: number}}
   */
  vssBackup () {
    return parse(binding.sdkNodeVssBackup(this._handle))
  }

  vssDeleteAll (request) { unsupported('vssDeleteAll') }

  /**
   * APay receiver-side registration with an LSP. Pass the LSP's
   * node_id (hex). Returns the parsed AsyncOrderNewResponse —
   * `{ request_id, host_node_id, protocol_version, order_id, status,
   *    accepted_through_index, next_index_expected, unused_hashes,
   *    refill_batch_size, first_hash_index }`. Upstream PR #51.
   *
   * @param {string} hostNodeId
   */
  apayNew (hostNodeId) {
    return parse(binding.sdkNodeApayNew(this._handle, hostNodeId))
  }

  /**
   * Register an APay hash batch and attest a Lightning Address to the LSP.
   * RLN signs both the batch and `username@domain` attestation with the
   * wallet node key; the native method enforces the same live-peer/channel
   * requirements as `apayNew`.
   *
   * @param {string} hostNodeId
   * @param {string} username
   * @param {string} domain
   */
  apayNewWithAddress (hostNodeId, username, domain) {
    return parse(binding.sdkNodeApayNewWithAddress(
      this._handle,
      hostNodeId,
      username,
      domain
    ))
  }

  // -------- External-signer lifecycle --------

  /**
   * Pin a NativeExternalSigner to this node (writes the key-source file
   * to the node's storage_dir_path). Idempotent in spirit: on a second
   * launch (key-source file already on disk) RLN throws `Rln(Conflict)`
   * which the caller can swallow safely — call `attach...` /
   * `unlock...` directly instead.
   *
   * @param {NativeExternalSigner} signer
   */
  initWithNativeExternalSigner (signer) {
    binding.sdkNodeInitWithNativeExternalSigner(this._handle, signer._handle)
  }

  /**
   * Attach a previously-initialised NativeExternalSigner to this node's
   * runtime state. Must precede any unlock call when running on a
   * pre-existing storage_dir.
   * @param {NativeExternalSigner} signer
   */
  attachNativeExternalSigner (signer) {
    binding.sdkNodeAttachNativeExternalSigner(this._handle, signer._handle)
  }

  /**
   * One-shot attach + unlock with a native signer.
   *
   * `request` is a `JsonSdkExternalUnlockRequest` — same shape as the
   * normal unlock request, minus `password` (which has no meaning in
   * external-signer mode).
   * @param {NativeExternalSigner} signer
   * @param {Object} request
   */
  unlockWithNativeExternalSigner (signer, request) {
    binding.sdkNodeUnlockWithNativeExternalSigner(
      this._handle,
      signer._handle,
      stringify(request)
    )
  }

  startUnlockWithNativeExternalSigner (signer, request) { unsupported('startUnlockWithNativeExternalSigner') }

  nativeOperationStatus (operationId) { unsupported('nativeOperationStatus') }

  adoptNativeOperation (operationId) { unsupported('adoptNativeOperation') }

  cancelNativeOperation (operationId) { unsupported('cancelNativeOperation') }

  /**
   * Initialise with a raw bootstrap dictionary. Used when the signer is
   * implemented by the host outside this binding (the foreign-signer
   * VLS-callback transport isn't exposed through this C-FFI yet, so
   * pairing this with `unlockWithAttachedExternalSigner` requires that
   * the attachment was made through a different mechanism).
   * @param {Object} bootstrap - JsonSdkExternalSignerBootstrap
   */
  initWithExternalSigner (bootstrap) {
    binding.sdkNodeInitWithExternalSigner(this._handle, stringify(bootstrap))
  }

  /** Drop the currently-attached external signer. */
  detachExternalSigner () {
    binding.sdkNodeDetachExternalSigner(this._handle)
  }

  /**
   * @param {Object} request - JsonSdkExternalUnlockRequest (no `password`)
   */
  unlockWithAttachedExternalSigner (request) {
    binding.sdkNodeUnlockWithAttachedExternalSigner(
      this._handle,
      stringify(request)
    )
  }

  // -------- Node info / network / sync --------

  nodeInfo () { return parse(binding.nodeInfo(this._handle)) }
  networkInfo () { return parse(binding.networkInfo(this._handle)) }
  sync () { return parse(binding.sync(this._handle)) }
  syncWallet (request) { unsupported('syncWallet') }
  walletSnapshot (request = {}) { unsupported('walletSnapshot') }
  address () { return parse(binding.address(this._handle)) }
  getAddress () { return this.address() }
  rotateAddress () { return parse(binding.rotateAddress(this._handle)) }

  // -------- Channels --------

  openChannel (request) {
    return parse(binding.openChannel(this._handle, stringify(request)))
  }
  closeChannel (request) {
    return parse(binding.closeChannel(this._handle, stringify(request)))
  }
  listChannels () {
    return parse(binding.listChannels(this._handle))
  }
  getChannelId (temporaryChannelIdHex) {
    return parse(binding.getChannelId(this._handle, temporaryChannelIdHex))
  }

  // -------- Peers --------

  connectPeer (peerPubkeyAndAddr) {
    return parse(binding.connectPeer(this._handle, peerPubkeyAndAddr))
  }
  disconnectPeer (request) {
    return parse(binding.disconnectPeer(this._handle, stringify(request)))
  }
  listPeers () {
    return parse(binding.listPeers(this._handle))
  }

  // -------- Invoices (BOLT11 + RGB) --------

  lnInvoice (request) {
    return parse(binding.lnInvoice(this._handle, stringify(request)))
  }
  decodeLnInvoice (invoice) {
    return parse(binding.decodeLnInvoice(this._handle, invoice))
  }
  invoiceStatus (invoice) {
    return parse(binding.invoiceStatus(this._handle, invoice))
  }
  rgbInvoice (request) {
    return parse(binding.rgbInvoice(this._handle, stringify(request)))
  }
  decodeRgbInvoice (invoice) {
    return parse(binding.decodeRgbInvoice(this._handle, invoice))
  }
  cancelHodlInvoice (request) {
    return parse(binding.cancelHodlInvoice(this._handle, stringify(request)))
  }
  claimHodlInvoice (request) {
    return parse(binding.claimHodlInvoice(this._handle, stringify(request)))
  }

  // -------- Payments --------

  sendPayment (request) {
    return parse(binding.sendPayment(this._handle, paymentRequest(request)))
  }
  keysend (request) {
    return parse(binding.keysend(this._handle, stringify(request)))
  }
  listPayments () {
    return parse(binding.listPayments(this._handle))
  }
  getPayment (paymentHashHex, paymentType) {
    return parse(binding.getPayment(this._handle, paymentHashHex, paymentType))
  }

  // -------- Swaps (atomic-swap maker/taker) --------

  makerInit (request) {
    return parse(binding.makerInit(this._handle, stringify(request)))
  }
  makerExecute (request) {
    return parse(binding.makerExecute(this._handle, stringify(request)))
  }
  taker (request) {
    return parse(binding.taker(this._handle, stringify(request)))
  }
  listSwaps () {
    return parse(binding.listSwaps(this._handle))
  }
  getSwap (paymentHash, takerFlag) {
    return parse(binding.getSwap(this._handle, paymentHash, !!takerFlag))
  }

  // -------- RGB asset issuance + transfers --------

  issueAssetNia (request) {
    return parse(binding.issueAssetNia(this._handle, stringify(request)))
  }
  issueAssetUda (request) {
    return parse(binding.issueAssetUda(this._handle, stringify(request)))
  }
  issueAssetCfa (request) {
    return parse(binding.issueAssetCfa(this._handle, stringify(request)))
  }
  issueAssetIfa (request) {
    return parse(binding.issueAssetIfa(this._handle, stringify(request)))
  }

  listAssets (filterAssetSchemas) {
    // filterAssetSchemas is an array | undefined → JSON-encoded
    const filter = stringify(filterAssetSchemas ?? [])
    return parse(binding.listAssets(this._handle, filter))
  }
  assetBalance (assetId) {
    return parse(binding.assetBalance(this._handle, assetId))
  }
  assetLinkCreate (request) {
    return parse(binding.assetLinkCreate(this._handle, stringify(request)))
  }
  assetMetadata (assetId) {
    return parse(binding.assetMetadata(this._handle, assetId))
  }

  listTransfers (assetId, txid) {
    if (assetId && typeof assetId === 'object') {
      return parse(binding.listTransfers(this._handle, assetId.asset_id ?? null, assetId.txid ?? null))
    }
    return parse(binding.listTransfers(this._handle, assetId ?? null, txid ?? null))
  }
  listTransfersByTxid (txid) {
    return parse(binding.listTransfersByTxid(this._handle, txid))
  }
  refreshTransfers (request) {
    return parse(binding.refreshTransfers(this._handle, stringify(request)))
  }
  failTransfers (request) {
    return parse(binding.failTransfers(this._handle, stringify(request)))
  }

  sendRgb (request) {
    return parse(binding.sendRgb(this._handle, stringify(request)))
  }

  importRgbTransferConsignment (request) { unsupported('importRgbTransferConsignment') }

  importRgbContract (request) { unsupported('importRgbContract') }

  prepareRgbSend (request) { unsupported('prepareRgbSend') }

  commitPreparedRgbSend (request) { unsupported('commitPreparedRgbSend') }
  cancelRgbSendPlan (request) { unsupported('cancelRgbSendPlan') }
  listPendingRgbSendPlans () { unsupported('listPendingRgbSendPlans') }
  inflate (request) {
    return parse(binding.inflate(this._handle, stringify(request)))
  }

  getAssetMedia (digest) {
    return parse(binding.getAssetMedia(this._handle, digest))
  }
  postAssetMedia (request) {
    return parse(binding.postAssetMedia(this._handle, stringify(request)))
  }

  // -------- BTC ops --------

  btcBalance (skipSync = false) {
    return parse(binding.btcBalance(this._handle, !!skipSync))
  }
  sendBtc (request) {
    return parse(binding.sendBtc(this._handle, stringify(request)))
  }

  prepareBtcSend (request) { unsupported('prepareBtcSend') }

  commitPreparedBtcSend (request) { unsupported('commitPreparedBtcSend') }

  cancelBtcSendPlan (request) { unsupported('cancelBtcSendPlan') }

  prepareCreateUtxos (request) { unsupported('prepareCreateUtxos') }

  commitPreparedCreateUtxos (request) { unsupported('commitPreparedCreateUtxos') }

  cancelCreateUtxosPlan (request) { unsupported('cancelCreateUtxosPlan') }

  listPendingVanillaTransactions () { unsupported('listPendingVanillaTransactions') }

  listAddressReceipts (address) { unsupported('listAddressReceipts') }

  listTransactions (skipSync = false) {
    return parse(binding.listTransactions(this._handle, !!skipSync))
  }
  listTransactionsByTxid (txid, skipSync = false) {
    return parse(binding.listTransactionsByTxid(this._handle, txid, !!skipSync))
  }
  listUnspents (skipSync = false) {
    return parse(binding.listUnspents(this._handle, !!skipSync))
  }
  createUtxos (request) {
    return parse(binding.createUtxos(this._handle, stringify(request)))
  }
  // blocks: u16 (1..=65535)
  estimateFee (blocks) {
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 0xffff) throw new RangeError('blocks must be a positive u16')
    return parse(binding.estimateFee(this._handle, blocks))
  }

  // -------- Onion / signing / diagnostics --------

  sendOnionMessage (request) {
    return parse(binding.sendOnionMessage(this._handle, stringify(request)))
  }
  signMessage (message) {
    return parse(binding.signMessage(this._handle, message))
  }
  verifyMessage (message, signature) {
    return parse(binding.verifyMessage(this._handle, message, signature))
  }
  checkIndexerUrl (indexerUrl) {
    return parse(binding.checkIndexerUrl(this._handle, indexerUrl))
  }
  checkProxyEndpoint (proxyEndpoint) {
    return parse(binding.checkProxyEndpoint(this._handle, proxyEndpoint))
  }
}

exports.SdkNode = SdkNode

/**
 * Host-provided VLS signer.
 *
 * The seed never reaches RLN's persistence layer — the host (e.g. the
 * WDK secret manager) supplies a stable 32-byte BIP-32 seed at unlock
 * time. Production channel wallets must use `createWithStorage` so VLS
 * commitment state survives process restarts. `create` is intentionally
 * retained for stateless tooling and tests that do not preserve channels.
 *
 * Lifecycle:
 *   1. `NativeExternalSigner.create(seedHex, network)`
 *   2. (first launch only) `node.initWithNativeExternalSigner(signer)`
 *   3. `node.unlockWithNativeExternalSigner(signer, rpcArgs)` — or
 *      `attachNativeExternalSigner` + `unlockWithAttachedExternalSigner`
 *
 * The instance can be dropped (`destroy()` or GC) as soon as RLN has
 * cloned its `Arc` ref via attach/init/unlock.
 */
class NativeExternalSigner {
  constructor (handle) {
    this._handle = handle
    this._destroyed = false
  }

  /**
   * @param {string} seedHex - 64-char hex string (32-byte BIP-32 entropy)
   * @param {string} network - "mainnet" | "testnet" | "testnet4" | "signet" | "regtest"
   * @param {boolean} [permissivePolicy=false] - VLS policy filter; pass
   *   `false` to enforce the full simple policy. Defaults to permissive
   *   for in-process use, mirroring RLN's `NativeExternalSigner::new`
   *   default of `Some(true)`.
   * @returns {NativeExternalSigner}
   */
  static create (seedHex, network, permissivePolicy = false) {
    if (typeof permissivePolicy !== 'boolean') throw new TypeError('permissivePolicy must be boolean')
    if (typeof seedHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
      throw new Error('NativeExternalSigner.create: seedHex must be a 64-char hex string')
    }
    return new NativeExternalSigner(
      binding.nativeExternalSignerNew(seedHex, network, !!permissivePolicy)
    )
  }

  /**
   * Construct a disk-backed signer whose channel validation state survives
   * process restarts. The storage directory is signer-private state and must
   * be stable for the wallet identity.
   *
   * @param {string} seedHex - 64-char hex string (32-byte BIP-32 entropy)
   * @param {string} network - "mainnet" | "testnet" | "testnet4" | "signet" | "regtest"
   * @param {string} storageDirPath - Stable, private signer-state directory
   * @param {boolean} [permissivePolicy=false] - VLS policy filter
   * @returns {NativeExternalSigner}
   */
  static createWithStorage (seedHex, network, storageDirPath, permissivePolicy = false) {
    if (typeof permissivePolicy !== 'boolean') throw new TypeError('permissivePolicy must be boolean')
    if (typeof seedHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
      throw new Error('NativeExternalSigner.createWithStorage: seedHex must be a 64-char hex string')
    }
    if (typeof storageDirPath !== 'string' || storageDirPath.length === 0) {
      throw new Error('NativeExternalSigner.createWithStorage: storageDirPath is required')
    }
    return new NativeExternalSigner(
      binding.nativeExternalSignerNewWithStorage(
        seedHex,
        network,
        !!permissivePolicy,
        storageDirPath
      )
    )
  }

  /**
   * Returns the bootstrap dictionary (node_id, account xpubs, master
   * fingerprint, protocol_version, api_level) — identifies the signer
   * to RLN without exposing the seed.
   */
  bootstrap () {
    if (this._destroyed) throw new Error('NativeExternalSigner already destroyed')
    return parse(binding.nativeExternalSignerBootstrap(this._handle))
  }

  // Eager drop. The GC destructor remains as an idempotent fallback.
  destroy () {
    if (this._destroyed) return
    binding.nativeExternalSignerDestroy(this._handle)
    this._handle = null
    this._destroyed = true
  }
}

exports.NativeExternalSigner = NativeExternalSigner
