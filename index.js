/**
 * @utexo/rgb-lightning-node-bare — JS façade for the rgb-lightning-node C-FFI.
 *
 * Mirrors the SdkNode UniFFI surface 1:1 (methods that take/return JSON
 * are parsed/stringified at this layer; native always sees strings).
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

// Module-level helpers (no SdkNode handle)

exports.uniffiHealthcheck = function () {
  return binding.uniffiHealthcheck()
}

exports.uniffiIsInitialized = function () {
  // Native returns "true" / "false" string — convert.
  return binding.uniffiIsInitialized() === 'true'
}

exports.sdkInitialize = function (request) {
  return binding.sdkInitialize(JSON.stringify(request))
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
    return new SdkNode(binding.sdkNodeNew(JSON.stringify(request)))
  }

  // -------- Lifecycle --------

  // Returns the mnemonic (whether passed in or freshly generated).
  init (password, mnemonic) {
    return binding.sdkNodeInit(this._handle, password, mnemonic ?? null)
  }

  unlock (request) {
    binding.sdkNodeUnlock(this._handle, JSON.stringify(request))
  }

  shutdown () {
    if (this._closed) return
    binding.sdkNodeShutdown(this._handle)
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
    binding.sdkNodeVssClearFence(this._handle, JSON.stringify(request))
  }

  /**
   * Force an immediate VSS backup flush. Returns `{ version }` where
   * version is the snapshot index just persisted. Throws if VSS isn't
   * configured (no `vssUrl` at init) or the flush fails (server
   * unreachable, auth rejected). Useful for app-controlled
   * checkpoints (e.g. "save state before app suspend") rather than
   * relying on the implicit on-write flush.
   *
   * Backed by upstream `vss_backup()` UniFFI method (PR #50). Requires
   * the C-FFI patch series at `rgb-lightning-node-bare/patches/` to be
   * applied before the static lib is built.
   *
   * @returns {{version: number}}
   */
  vssBackup () {
    return JSON.parse(binding.sdkNodeVssBackup(this._handle))
  }

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
    return JSON.parse(binding.sdkNodeApayNew(this._handle, hostNodeId))
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
      JSON.stringify(request)
    )
  }

  /**
   * Initialise with a raw bootstrap dictionary. Used when the signer is
   * implemented by the host outside this binding (the foreign-signer
   * VLS-callback transport isn't exposed through this C-FFI yet, so
   * pairing this with `unlockWithAttachedExternalSigner` requires that
   * the attachment was made through a different mechanism).
   * @param {Object} bootstrap - JsonSdkExternalSignerBootstrap
   */
  initWithExternalSigner (bootstrap) {
    binding.sdkNodeInitWithExternalSigner(this._handle, JSON.stringify(bootstrap))
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
      JSON.stringify(request)
    )
  }

  // -------- Node info / network / sync --------

  nodeInfo () { return JSON.parse(binding.nodeInfo(this._handle)) }
  networkInfo () { return JSON.parse(binding.networkInfo(this._handle)) }
  sync () { return JSON.parse(binding.sync(this._handle)) }
  address () { return JSON.parse(binding.address(this._handle)) }

  // -------- Channels --------

  openChannel (request) {
    return JSON.parse(binding.openChannel(this._handle, JSON.stringify(request)))
  }
  closeChannel (request) {
    return JSON.parse(binding.closeChannel(this._handle, JSON.stringify(request)))
  }
  listChannels () {
    return JSON.parse(binding.listChannels(this._handle))
  }
  getChannelId (temporaryChannelIdHex) {
    return JSON.parse(binding.getChannelId(this._handle, temporaryChannelIdHex))
  }

  // -------- Peers --------

  connectPeer (peerPubkeyAndAddr) {
    return JSON.parse(binding.connectPeer(this._handle, peerPubkeyAndAddr))
  }
  disconnectPeer (request) {
    return JSON.parse(binding.disconnectPeer(this._handle, JSON.stringify(request)))
  }
  listPeers () {
    return JSON.parse(binding.listPeers(this._handle))
  }

  // -------- Invoices (BOLT11 + RGB) --------

  lnInvoice (request) {
    return JSON.parse(binding.lnInvoice(this._handle, JSON.stringify(request)))
  }
  decodeLnInvoice (invoice) {
    return JSON.parse(binding.decodeLnInvoice(this._handle, invoice))
  }
  invoiceStatus (invoice) {
    return JSON.parse(binding.invoiceStatus(this._handle, invoice))
  }
  rgbInvoice (request) {
    return JSON.parse(binding.rgbInvoice(this._handle, JSON.stringify(request)))
  }
  decodeRgbInvoice (invoice) {
    return JSON.parse(binding.decodeRgbInvoice(this._handle, invoice))
  }
  cancelHodlInvoice (request) {
    return JSON.parse(binding.cancelHodlInvoice(this._handle, JSON.stringify(request)))
  }
  claimHodlInvoice (request) {
    return JSON.parse(binding.claimHodlInvoice(this._handle, JSON.stringify(request)))
  }

  // -------- Payments --------

  sendPayment (request) {
    return JSON.parse(binding.sendPayment(this._handle, JSON.stringify(request)))
  }
  keysend (request) {
    return JSON.parse(binding.keysend(this._handle, JSON.stringify(request)))
  }
  listPayments () {
    return JSON.parse(binding.listPayments(this._handle))
  }
  getPayment (paymentHashHex, paymentType) {
    return JSON.parse(binding.getPayment(this._handle, paymentHashHex, paymentType))
  }

  // -------- Swaps (atomic-swap maker/taker) --------

  makerInit (request) {
    return JSON.parse(binding.makerInit(this._handle, JSON.stringify(request)))
  }
  makerExecute (request) {
    return JSON.parse(binding.makerExecute(this._handle, JSON.stringify(request)))
  }
  taker (request) {
    return JSON.parse(binding.taker(this._handle, JSON.stringify(request)))
  }
  listSwaps () {
    return JSON.parse(binding.listSwaps(this._handle))
  }
  getSwap (paymentHash, takerFlag) {
    return JSON.parse(binding.getSwap(this._handle, paymentHash, !!takerFlag))
  }

  // -------- RGB asset issuance + transfers --------

  issueAssetNia (request) {
    return JSON.parse(binding.issueAssetNia(this._handle, JSON.stringify(request)))
  }
  issueAssetUda (request) {
    return JSON.parse(binding.issueAssetUda(this._handle, JSON.stringify(request)))
  }
  issueAssetCfa (request) {
    return JSON.parse(binding.issueAssetCfa(this._handle, JSON.stringify(request)))
  }
  issueAssetIfa (request) {
    return JSON.parse(binding.issueAssetIfa(this._handle, JSON.stringify(request)))
  }

  listAssets (filterAssetSchemas) {
    // filterAssetSchemas is an array | undefined → JSON-encoded
    const filter = JSON.stringify(filterAssetSchemas ?? [])
    return JSON.parse(binding.listAssets(this._handle, filter))
  }
  assetBalance (assetId) {
    return JSON.parse(binding.assetBalance(this._handle, assetId))
  }
  assetMetadata (assetId) {
    return JSON.parse(binding.assetMetadata(this._handle, assetId))
  }

  listTransfers (assetId) {
    return JSON.parse(binding.listTransfers(this._handle, assetId))
  }
  refreshTransfers (request) {
    return JSON.parse(binding.refreshTransfers(this._handle, JSON.stringify(request)))
  }
  failTransfers (request) {
    return JSON.parse(binding.failTransfers(this._handle, JSON.stringify(request)))
  }

  sendRgb (request) {
    return JSON.parse(binding.sendRgb(this._handle, JSON.stringify(request)))
  }
  inflate (request) {
    return JSON.parse(binding.inflate(this._handle, JSON.stringify(request)))
  }

  getAssetMedia (digest) {
    return JSON.parse(binding.getAssetMedia(this._handle, digest))
  }
  postAssetMedia (request) {
    return JSON.parse(binding.postAssetMedia(this._handle, JSON.stringify(request)))
  }

  // -------- BTC ops --------

  btcBalance (skipSync = false) {
    return JSON.parse(binding.btcBalance(this._handle, !!skipSync))
  }
  sendBtc (request) {
    return JSON.parse(binding.sendBtc(this._handle, JSON.stringify(request)))
  }
  listTransactions (skipSync = false) {
    return JSON.parse(binding.listTransactions(this._handle, !!skipSync))
  }
  listUnspents (skipSync = false) {
    return JSON.parse(binding.listUnspents(this._handle, !!skipSync))
  }
  createUtxos (request) {
    return JSON.parse(binding.createUtxos(this._handle, JSON.stringify(request)))
  }
  // blocks: u16 (1..=65535)
  estimateFee (blocks) {
    return JSON.parse(binding.estimateFee(this._handle, blocks >>> 0))
  }

  // -------- Onion / signing / diagnostics --------

  sendOnionMessage (request) {
    return JSON.parse(binding.sendOnionMessage(this._handle, JSON.stringify(request)))
  }
  signMessage (message) {
    return JSON.parse(binding.signMessage(this._handle, message))
  }
  checkIndexerUrl (indexerUrl) {
    return JSON.parse(binding.checkIndexerUrl(this._handle, indexerUrl))
  }
  checkProxyEndpoint (proxyEndpoint) {
    return JSON.parse(binding.checkProxyEndpoint(this._handle, proxyEndpoint))
  }
}

exports.SdkNode = SdkNode

/**
 * Host-provided in-memory VLS signer.
 *
 * The seed never reaches RLN's persistence layer — the host (e.g. the
 * WDK secret manager) supplies a stable 32-byte BIP-32 seed at unlock
 * time, the VLS signer state lives entirely in process memory, and
 * everything cryptographic happens in-process via `signer-external` /
 * `vls-protocol-signer`.
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
   * @param {boolean} [permissivePolicy=true] - VLS policy filter; pass
   *   `false` to enforce the full simple policy. Defaults to permissive
   *   for in-process use, mirroring RLN's `NativeExternalSigner::new`
   *   default of `Some(true)`.
   * @returns {NativeExternalSigner}
   */
  static create (seedHex, network, permissivePolicy = true) {
    if (typeof seedHex !== 'string' || seedHex.length !== 64) {
      throw new Error('NativeExternalSigner.create: seedHex must be a 64-char hex string')
    }
    return new NativeExternalSigner(
      binding.nativeExternalSignerNew(seedHex, network, !!permissivePolicy)
    )
  }

  /**
   * Returns the bootstrap dictionary (node_id, account xpubs, master
   * fingerprint, protocol_version, api_level) — identifies the signer
   * to RLN without exposing the seed.
   */
  bootstrap () {
    if (this._destroyed) throw new Error('NativeExternalSigner already destroyed')
    return JSON.parse(binding.nativeExternalSignerBootstrap(this._handle))
  }

  // Eager drop. Optional — the GC destructor handles it otherwise.
  destroy () {
    // The native destructor runs on GC; nothing explicit to do here yet,
    // but we keep this method so consumers can express intent and we
    // can switch to an explicit-free C-FFI later without an API churn.
    this._destroyed = true
  }
}

exports.NativeExternalSigner = NativeExternalSigner
