/**
 * @utexo/rgb-lightning-node-bare — Bare native addon wrapping the
 * rgb-lightning-node C-FFI.
 *
 * Wires every `rln_*` function from rln.h into a JS surface. Mirrors
 * the rgb-lib-bare pattern (sodium-native style: <bare.h> + <js.h>).
 */

#include <bare.h>
#include <js.h>
#include <stdlib.h>
#include <string.h>

extern "C" {
#include "rln.h"
}

// ============================================================================
// Helpers
// ============================================================================

static char *js_to_cstring(js_env_t *env, js_value_t *val) {
  js_value_type_t type;
  js_typeof(env, val, &type);
  if (type == js_null || type == js_undefined) return NULL;

  size_t len;
  js_get_value_string_utf8(env, val, NULL, 0, &len);
  utf8_t *buf = (utf8_t *)malloc(len + 1);
  js_get_value_string_utf8(env, val, buf, len + 1, NULL);
  return (char *)buf;
}

static js_value_t *cstring_to_js(js_env_t *env, const char *str) {
  if (!str) {
    js_value_t *null_val;
    js_get_null(env, &null_val);
    return null_val;
  }
  js_value_t *result;
  js_create_string_utf8(env, (const utf8_t *)str, strlen(str), &result);
  return result;
}

static js_value_t *handle_result_string(js_env_t *env, struct CResultString res) {
  if (res.result == Ok) {
    js_value_t *val = cstring_to_js(env, res.inner);
    if (res.inner) rln_free_string(res.inner);
    return val;
  } else {
    const char *msg = res.inner ? res.inner : "Unknown rgb-lightning-node error";
    js_throw_error(env, NULL, msg);
    if (res.inner) rln_free_string(res.inner);
    js_value_t *undef;
    js_get_undefined(env, &undef);
    return undef;
  }
}

static bool js_to_bool(js_env_t *env, js_value_t *val) {
  bool b = false;
  js_get_value_bool(env, val, &b);
  return b;
}

static uint32_t js_to_uint32(js_env_t *env, js_value_t *val) {
  uint32_t n = 0;
  js_get_value_uint32(env, val, &n);
  return n;
}

// ============================================================================
// Opaque handle management (SdkNode)
// ============================================================================

struct SdkNodeRef {
  struct COpaqueStruct opaque;
  bool freed;
};

static void sdk_node_destructor(js_env_t *env, void *data, void *hint) {
  SdkNodeRef *ref = (SdkNodeRef *)data;
  if (!ref->freed) {
    rln_sdk_node_shutdown(&ref->opaque);
    free_sdk_node(ref->opaque);
  }
  free(ref);
}

static js_value_t *wrap_sdk_node(js_env_t *env, struct COpaqueStruct opaque) {
  SdkNodeRef *ref = (SdkNodeRef *)malloc(sizeof(SdkNodeRef));
  ref->opaque = opaque;
  ref->freed = false;

  js_value_t *external;
  js_create_external(env, ref, sdk_node_destructor, NULL, &external);
  return external;
}

static const struct COpaqueStruct *unwrap_sdk_node(js_env_t *env, js_value_t *val) {
  void *data;
  js_get_value_external(env, val, &data);
  SdkNodeRef *ref = (SdkNodeRef *)data;
  return &ref->opaque;
}

static js_value_t *handle_result_node(js_env_t *env, struct CResult res) {
  if (res.result == Ok) {
    return wrap_sdk_node(env, res.inner);
  } else {
    const char *msg = res.inner.ptr ? (const char *)res.inner.ptr
                                    : "Unknown rgb-lightning-node error";
    js_throw_error(env, NULL, msg);
    js_value_t *undef;
    js_get_undefined(env, &undef);
    return undef;
  }
}

// ============================================================================
// Opaque handle management (NativeExternalSigner)
//
// The signer object is allocated in the C-FFI layer as
// `Box<Arc<NativeExternalSigner>>` and is type-tag-distinct from `SdkNode`.
// We keep a separate wrap/unwrap pair plus an explicit `freed` guard so the
// JS-side GC can drop the handle eagerly (without waiting for the node to
// shut down) — RLN clones the underlying `Arc` internally when the signer
// is attached, so dropping our handle is safe at any point post-attach.
// ============================================================================

struct SignerRef {
  struct COpaqueStruct opaque;
  bool freed;
};

static void signer_destructor(js_env_t *env, void *data, void *hint) {
  SignerRef *ref = (SignerRef *)data;
  if (!ref->freed) {
    free_native_external_signer(ref->opaque);
    ref->freed = true;
  }
  free(ref);
}

static js_value_t *wrap_signer(js_env_t *env, struct COpaqueStruct opaque) {
  SignerRef *ref = (SignerRef *)malloc(sizeof(SignerRef));
  ref->opaque = opaque;
  ref->freed = false;

  js_value_t *external;
  js_create_external(env, ref, signer_destructor, NULL, &external);
  return external;
}

static const struct COpaqueStruct *unwrap_signer(js_env_t *env, js_value_t *val) {
  void *data;
  js_get_value_external(env, val, &data);
  SignerRef *ref = (SignerRef *)data;
  return &ref->opaque;
}

static js_value_t *handle_result_signer(js_env_t *env, struct CResult res) {
  if (res.result == Ok) {
    return wrap_signer(env, res.inner);
  } else {
    const char *msg = res.inner.ptr ? (const char *)res.inner.ptr
                                    : "Unknown rgb-lightning-node error";
    js_throw_error(env, NULL, msg);
    js_value_t *undef;
    js_get_undefined(env, &undef);
    return undef;
  }
}

static int get_args(js_env_t *env, js_callback_info_t *info,
                    js_value_t **args, size_t expected) {
  size_t argc = expected;
  js_get_callback_info(env, info, &argc, args, NULL, NULL);
  return (int)argc;
}

// ============================================================================
// Macros
//
// The vast majority of rln_* functions share one of three shapes:
//   FN_NODE        : (node)         → CResultString
//   FN_NODE_STR    : (node, str)    → CResultString  (asset_id / invoice / msg)
//   FN_NODE_JSON   : (node, json)   → CResultString  (request_json)
//   FN_NODE_BOOL   : (node, bool)   → CResultString  (skip_sync)
// ============================================================================

#define FN_NODE(NAME, RLN_FN)                                              \
  static js_value_t *fn_##NAME(js_env_t *env, js_callback_info_t *info) {  \
    js_value_t *args[1];                                                   \
    get_args(env, info, args, 1);                                          \
    const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);      \
    return handle_result_string(env, RLN_FN(node));                        \
  }

#define FN_NODE_STR(NAME, RLN_FN)                                          \
  static js_value_t *fn_##NAME(js_env_t *env, js_callback_info_t *info) {  \
    js_value_t *args[2];                                                   \
    get_args(env, info, args, 2);                                          \
    const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);      \
    char *s = js_to_cstring(env, args[1]);                                 \
    struct CResultString res = RLN_FN(node, s);                            \
    free(s);                                                               \
    return handle_result_string(env, res);                                 \
  }

#define FN_NODE_JSON(NAME, RLN_FN) FN_NODE_STR(NAME, RLN_FN)

#define FN_NODE_BOOL(NAME, RLN_FN)                                         \
  static js_value_t *fn_##NAME(js_env_t *env, js_callback_info_t *info) {  \
    js_value_t *args[2];                                                   \
    get_args(env, info, args, 2);                                          \
    const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);      \
    bool b = js_to_bool(env, args[1]);                                     \
    return handle_result_string(env, RLN_FN(node, b));                     \
  }

// ============================================================================
// Module-level (no node)
// ============================================================================

static js_value_t *fn_uniffi_healthcheck(js_env_t *env, js_callback_info_t *info) {
  return handle_result_string(env, rln_uniffi_healthcheck());
}

static js_value_t *fn_uniffi_is_initialized(js_env_t *env, js_callback_info_t *info) {
  return handle_result_string(env, rln_uniffi_is_initialized());
}

static js_value_t *fn_sdk_initialize(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  char *request_json = js_to_cstring(env, args[0]);
  struct CResultString res = rln_sdk_initialize(request_json);
  free(request_json);
  return handle_result_string(env, res);
}

static js_value_t *fn_sdk_shutdown(js_env_t *env, js_callback_info_t *info) {
  return handle_result_string(env, rln_sdk_shutdown());
}

// ============================================================================
// SdkNode lifecycle
// ============================================================================

static js_value_t *fn_sdk_node_new(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  char *request_json = js_to_cstring(env, args[0]);
  struct CResult res = rln_sdk_node_new(request_json);
  free(request_json);
  return handle_result_node(env, res);
}

static js_value_t *fn_sdk_node_init(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  char *password = js_to_cstring(env, args[1]);
  char *mnemonic = js_to_cstring(env, args[2]);
  struct CResultString res = rln_sdk_node_init(node, password, mnemonic);
  free(password);
  free(mnemonic);
  return handle_result_string(env, res);
}

FN_NODE_JSON(sdk_node_unlock, rln_sdk_node_unlock)
FN_NODE(sdk_node_shutdown, rln_sdk_node_shutdown)
FN_NODE_JSON(sdk_node_vss_clear_fence, rln_sdk_node_vss_clear_fence)
FN_NODE(sdk_node_vss_backup, rln_sdk_node_vss_backup)
FN_NODE_STR(sdk_node_apay_new, rln_sdk_node_apay_new)

// ============================================================================
// External-signer surface
// ============================================================================

static js_value_t *fn_native_external_signer_new(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  char *seed_hex = js_to_cstring(env, args[0]);
  char *network = js_to_cstring(env, args[1]);
  bool permissive_policy = js_to_bool(env, args[2]);
  struct CResult res = rln_native_external_signer_new(seed_hex, network, permissive_policy);
  free(seed_hex);
  free(network);
  return handle_result_signer(env, res);
}

static js_value_t *fn_native_external_signer_bootstrap(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  const struct COpaqueStruct *signer = unwrap_signer(env, args[0]);
  return handle_result_string(env, rln_native_external_signer_bootstrap(signer));
}

// `node` + `signer` form (3 of these): init / attach / unlock-with-native
// share the same shape — wrap them through a single helper macro.

#define FN_NODE_SIGNER(NAME, RLN_FN)                                          \
  static js_value_t *fn_##NAME(js_env_t *env, js_callback_info_t *info) {     \
    js_value_t *args[2];                                                      \
    get_args(env, info, args, 2);                                             \
    const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);         \
    const struct COpaqueStruct *signer = unwrap_signer(env, args[1]);         \
    return handle_result_string(env, RLN_FN(node, signer));                   \
  }

FN_NODE_SIGNER(sdk_node_init_with_native_external_signer,
               rln_sdk_node_init_with_native_external_signer)
FN_NODE_SIGNER(sdk_node_attach_native_external_signer,
               rln_sdk_node_attach_native_external_signer)

static js_value_t *fn_sdk_node_unlock_with_native_external_signer(js_env_t *env,
                                                                  js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  const struct COpaqueStruct *signer = unwrap_signer(env, args[1]);
  char *request_json = js_to_cstring(env, args[2]);
  struct CResultString res =
    rln_sdk_node_unlock_with_native_external_signer(node, signer, request_json);
  free(request_json);
  return handle_result_string(env, res);
}

// `node` + `bootstrap_json` / `unlock_request_json` — host-implemented
// signer path. Reuse the FN_NODE_JSON shape.
FN_NODE_JSON(sdk_node_init_with_external_signer, rln_sdk_node_init_with_external_signer)
FN_NODE(sdk_node_detach_external_signer, rln_sdk_node_detach_external_signer)
FN_NODE_JSON(sdk_node_unlock_with_attached_external_signer,
             rln_sdk_node_unlock_with_attached_external_signer)

// ============================================================================
// Node info / network / sync
// ============================================================================

FN_NODE(node_info, rln_node_info)
FN_NODE(network_info, rln_network_info)
FN_NODE(sync, rln_sync)
FN_NODE(address, rln_address)
FN_NODE(rotate_address, rln_rotate_address)

// ============================================================================
// Channels
// ============================================================================

FN_NODE_JSON(open_channel, rln_open_channel)
FN_NODE_JSON(close_channel, rln_close_channel)
FN_NODE(list_channels, rln_list_channels)
FN_NODE_STR(get_channel_id, rln_get_channel_id)

// ============================================================================
// Peers
// ============================================================================

FN_NODE_STR(connect_peer, rln_connect_peer)
FN_NODE_JSON(disconnect_peer, rln_disconnect_peer)
FN_NODE(list_peers, rln_list_peers)

// ============================================================================
// Invoices (BOLT11 + RGB)
// ============================================================================

FN_NODE_JSON(ln_invoice, rln_ln_invoice)
FN_NODE_STR(decode_ln_invoice, rln_decode_ln_invoice)
FN_NODE_STR(invoice_status, rln_invoice_status)
FN_NODE_JSON(rgb_invoice, rln_rgb_invoice)
FN_NODE_STR(decode_rgb_invoice, rln_decode_rgb_invoice)

// Hodl invoices
FN_NODE_JSON(cancel_hodl_invoice, rln_cancel_hodl_invoice)
FN_NODE_JSON(claim_hodl_invoice, rln_claim_hodl_invoice)

// ============================================================================
// Payments
// ============================================================================

FN_NODE_JSON(send_payment, rln_send_payment)
FN_NODE_JSON(keysend, rln_keysend)
FN_NODE(list_payments, rln_list_payments)

static js_value_t *fn_get_payment(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  char *hash = js_to_cstring(env, args[1]);
  char *type = js_to_cstring(env, args[2]);
  struct CResultString res = rln_get_payment(node, hash, type);
  free(hash);
  free(type);
  return handle_result_string(env, res);
}

// ============================================================================
// Swaps (atomic-swap maker/taker)
// ============================================================================

FN_NODE_JSON(maker_init, rln_maker_init)
FN_NODE_JSON(maker_execute, rln_maker_execute)
FN_NODE_JSON(taker, rln_taker)
FN_NODE(list_swaps, rln_list_swaps)

static js_value_t *fn_get_swap(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  char *hash = js_to_cstring(env, args[1]);
  bool taker_flag = js_to_bool(env, args[2]);
  struct CResultString res = rln_get_swap(node, hash, taker_flag);
  free(hash);
  return handle_result_string(env, res);
}

// ============================================================================
// RGB asset issuance + transfers
// ============================================================================

FN_NODE_JSON(issue_asset_nia, rln_issue_asset_nia)
FN_NODE_JSON(issue_asset_uda, rln_issue_asset_uda)
FN_NODE_JSON(issue_asset_cfa, rln_issue_asset_cfa)
FN_NODE_JSON(issue_asset_ifa, rln_issue_asset_ifa)

FN_NODE_JSON(list_assets, rln_list_assets)
FN_NODE_STR(asset_balance, rln_asset_balance)
FN_NODE_STR(asset_metadata, rln_asset_metadata)

FN_NODE_STR(list_transfers, rln_list_transfers)
FN_NODE_STR(list_transfers_by_txid, rln_list_transfers_by_txid)
FN_NODE_JSON(refresh_transfers, rln_refresh_transfers)
FN_NODE_JSON(fail_transfers, rln_fail_transfers)

FN_NODE_JSON(send_rgb, rln_send_rgb)
FN_NODE_JSON(inflate, rln_inflate)

// Asset media
FN_NODE_STR(get_asset_media, rln_get_asset_media)
FN_NODE_JSON(post_asset_media, rln_post_asset_media)

// ============================================================================
// BTC ops
// ============================================================================

FN_NODE_BOOL(btc_balance, rln_btc_balance)
FN_NODE_JSON(send_btc, rln_send_btc)
FN_NODE_BOOL(list_transactions, rln_list_transactions)

static js_value_t *fn_list_transactions_by_txid(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  char *txid = js_to_cstring(env, args[1]);
  bool skip_sync = js_to_bool(env, args[2]);
  struct CResultString res = rln_list_transactions_by_txid(node, txid, skip_sync);
  free(txid);
  return handle_result_string(env, res);
}

FN_NODE_BOOL(list_unspents, rln_list_unspents)
FN_NODE_JSON(create_utxos, rln_create_utxos)

static js_value_t *fn_estimate_fee(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[2];
  get_args(env, info, args, 2);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  uint32_t blocks_u32 = js_to_uint32(env, args[1]);
  uint16_t blocks = (uint16_t)(blocks_u32 & 0xFFFF);
  return handle_result_string(env, rln_estimate_fee(node, blocks));
}

// ============================================================================
// Onion messages + signing + diagnostics
// ============================================================================

FN_NODE_JSON(send_onion_message, rln_send_onion_message)
FN_NODE_STR(sign_message, rln_sign_message)

static js_value_t *fn_verify_message(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  char *message = js_to_cstring(env, args[1]);
  char *signature = js_to_cstring(env, args[2]);
  struct CResultString res = rln_verify_message(node, message, signature);
  free(message);
  free(signature);
  return handle_result_string(env, res);
}

FN_NODE_STR(check_indexer_url, rln_check_indexer_url)
FN_NODE_STR(check_proxy_endpoint, rln_check_proxy_endpoint)

// ============================================================================
// Module exports
// ============================================================================

static void set_fn(js_env_t *env, js_value_t *exports, const char *name,
                   js_value_t *(*fn)(js_env_t *, js_callback_info_t *)) {
  js_value_t *js_fn;
  js_create_function(env, name, strlen(name), fn, NULL, &js_fn);
  js_set_named_property(env, exports, name, js_fn);
}

#define EXPORT(JS_NAME, C_NAME) set_fn(env, exports, JS_NAME, fn_##C_NAME)

static js_value_t *
rgb_lightning_node_bare_exports(js_env_t *env, js_value_t *exports) {
  // Module-level
  EXPORT("uniffiHealthcheck", uniffi_healthcheck);
  EXPORT("uniffiIsInitialized", uniffi_is_initialized);
  EXPORT("sdkInitialize", sdk_initialize);
  EXPORT("sdkShutdown", sdk_shutdown);

  // Lifecycle
  EXPORT("sdkNodeNew", sdk_node_new);
  EXPORT("sdkNodeInit", sdk_node_init);
  EXPORT("sdkNodeUnlock", sdk_node_unlock);
  EXPORT("sdkNodeShutdown", sdk_node_shutdown);
  EXPORT("sdkNodeVssClearFence", sdk_node_vss_clear_fence);
  EXPORT("sdkNodeVssBackup", sdk_node_vss_backup);
  EXPORT("sdkNodeApayNew", sdk_node_apay_new);

  // External signer (native — recommended)
  EXPORT("nativeExternalSignerNew", native_external_signer_new);
  EXPORT("nativeExternalSignerBootstrap", native_external_signer_bootstrap);
  EXPORT("sdkNodeInitWithNativeExternalSigner",
         sdk_node_init_with_native_external_signer);
  EXPORT("sdkNodeAttachNativeExternalSigner",
         sdk_node_attach_native_external_signer);
  EXPORT("sdkNodeUnlockWithNativeExternalSigner",
         sdk_node_unlock_with_native_external_signer);

  // External signer (host-implemented — bootstrap dict only;
  // foreign-signer callback transport not yet exposed)
  EXPORT("sdkNodeInitWithExternalSigner", sdk_node_init_with_external_signer);
  EXPORT("sdkNodeDetachExternalSigner", sdk_node_detach_external_signer);
  EXPORT("sdkNodeUnlockWithAttachedExternalSigner",
         sdk_node_unlock_with_attached_external_signer);

  // Node info / network / sync
  EXPORT("nodeInfo", node_info);
  EXPORT("networkInfo", network_info);
  EXPORT("sync", sync);
  EXPORT("address", address);
  EXPORT("rotateAddress", rotate_address);

  // Channels
  EXPORT("openChannel", open_channel);
  EXPORT("closeChannel", close_channel);
  EXPORT("listChannels", list_channels);
  EXPORT("getChannelId", get_channel_id);

  // Peers
  EXPORT("connectPeer", connect_peer);
  EXPORT("disconnectPeer", disconnect_peer);
  EXPORT("listPeers", list_peers);

  // Invoices
  EXPORT("lnInvoice", ln_invoice);
  EXPORT("decodeLnInvoice", decode_ln_invoice);
  EXPORT("invoiceStatus", invoice_status);
  EXPORT("rgbInvoice", rgb_invoice);
  EXPORT("decodeRgbInvoice", decode_rgb_invoice);
  EXPORT("cancelHodlInvoice", cancel_hodl_invoice);
  EXPORT("claimHodlInvoice", claim_hodl_invoice);

  // Payments
  EXPORT("sendPayment", send_payment);
  EXPORT("keysend", keysend);
  EXPORT("listPayments", list_payments);
  EXPORT("getPayment", get_payment);

  // Swaps
  EXPORT("makerInit", maker_init);
  EXPORT("makerExecute", maker_execute);
  EXPORT("taker", taker);
  EXPORT("listSwaps", list_swaps);
  EXPORT("getSwap", get_swap);

  // RGB
  EXPORT("issueAssetNia", issue_asset_nia);
  EXPORT("issueAssetUda", issue_asset_uda);
  EXPORT("issueAssetCfa", issue_asset_cfa);
  EXPORT("issueAssetIfa", issue_asset_ifa);
  EXPORT("listAssets", list_assets);
  EXPORT("assetBalance", asset_balance);
  EXPORT("assetMetadata", asset_metadata);
  EXPORT("listTransfers", list_transfers);
  EXPORT("listTransfersByTxid", list_transfers_by_txid);
  EXPORT("refreshTransfers", refresh_transfers);
  EXPORT("failTransfers", fail_transfers);
  EXPORT("sendRgb", send_rgb);
  EXPORT("inflate", inflate);
  EXPORT("getAssetMedia", get_asset_media);
  EXPORT("postAssetMedia", post_asset_media);

  // BTC ops
  EXPORT("btcBalance", btc_balance);
  EXPORT("sendBtc", send_btc);
  EXPORT("listTransactions", list_transactions);
  EXPORT("listTransactionsByTxid", list_transactions_by_txid);
  EXPORT("listUnspents", list_unspents);
  EXPORT("createUtxos", create_utxos);
  EXPORT("estimateFee", estimate_fee);

  // Onion / signing / diagnostics
  EXPORT("sendOnionMessage", send_onion_message);
  EXPORT("signMessage", sign_message);
  EXPORT("verifyMessage", verify_message);
  EXPORT("checkIndexerUrl", check_indexer_url);
  EXPORT("checkProxyEndpoint", check_proxy_endpoint);

  return exports;
}

BARE_MODULE(rgb_lightning_node_bare, rgb_lightning_node_bare_exports)
