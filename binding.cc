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
#include <stdint.h>
#include <math.h>
#include <mutex>

extern "C" {
#include "rln.h"
}

// ============================================================================
// Helpers
// ============================================================================

enum class HandleKind { Node, Signer };
struct HandleEntry {
  js_env_t *env;
  HandleKind kind;
  HandleEntry *next;
};
static std::mutex handles_mutex;
static HandleEntry *handles = NULL;

static void register_handle(HandleEntry *entry, js_env_t *env, HandleKind kind) {
  std::lock_guard<std::mutex> guard(handles_mutex);
  entry->env = env;
  entry->kind = kind;
  entry->next = handles;
  handles = entry;
}

static bool owns_handle(js_env_t *env, void *data, HandleKind kind) {
  std::lock_guard<std::mutex> guard(handles_mutex);
  for (HandleEntry *entry = handles; entry != NULL; entry = entry->next) {
    if ((void *)entry == data) return entry->env == env && entry->kind == kind;
  }
  return false;
}

static bool read_external(js_env_t *env, js_value_t *value, void **data) {
  js_value_type_t type;
  return js_typeof(env, value, &type) == 0 && type == js_external &&
         js_get_value_external(env, value, data) == 0;
}

static void unregister_handle(HandleEntry *entry) {
  std::lock_guard<std::mutex> guard(handles_mutex);
  for (HandleEntry **cursor = &handles; *cursor != NULL; cursor = &(*cursor)->next) {
    if (*cursor == entry) {
      *cursor = entry->next;
      return;
    }
  }
}

class CStringArg {
 public:
  char *value = NULL;
  bool valid = false;

  CStringArg(js_env_t *env, js_value_t *input, bool nullable = false) {
    js_value_type_t type;
    if (js_typeof(env, input, &type) != 0) return;
    if (nullable && (type == js_null || type == js_undefined)) {
      valid = true;
      return;
    }
    if (type != js_string) {
      js_throw_type_error(env, "ERR_RLN_ARGUMENT", "Expected a string argument");
      return;
    }
    size_t length = 0;
    if (js_get_value_string_utf8(env, input, NULL, 0, &length) != 0 || length == SIZE_MAX) {
      js_throw_error(env, "ERR_RLN_ARGUMENT", "Unable to read string argument");
      return;
    }
    value = (char *)malloc(length + 1);
    if (value == NULL) {
      js_throw_error(env, "ERR_RLN_ALLOCATION", "Unable to allocate string argument");
      return;
    }
    if (js_get_value_string_utf8(env, input, (utf8_t *)value, length + 1, NULL) != 0) return;
    if (memchr(value, 0, length) != NULL) {
      js_throw_type_error(env, "ERR_RLN_ARGUMENT", "String argument contains a NUL byte");
      return;
    }
    valid = true;
  }

  ~CStringArg() { free(value); }
  CStringArg(const CStringArg &) = delete;
  CStringArg &operator=(const CStringArg &) = delete;
  operator const char *() const { return value; }
};

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

static js_value_t *make_undefined(js_env_t *env) {
  js_value_t *undefined;
  js_get_undefined(env, &undefined);
  return undefined;
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

static bool read_bool(js_env_t *env, js_value_t *val, bool *out) {
  js_value_type_t type;
  if (js_typeof(env, val, &type) != 0) return false;
  if (type != js_boolean) {
    js_throw_type_error(env, "ERR_RLN_ARGUMENT", "Expected a boolean argument");
    return false;
  }
  return js_get_value_bool(env, val, out) == 0;
}

// ============================================================================
// Opaque handle management (SdkNode)
// ============================================================================

struct SdkNodeRef {
  HandleEntry handle;
  struct COpaqueStruct opaque;
  bool freed;
  bool shutdown_attempted;
  bool teardown_registered;
};

static void shutdown_and_free_sdk_node(SdkNodeRef *ref) {
  if (!ref->freed) {
    if (!ref->shutdown_attempted) {
      struct CResultString shutdown_result = rln_sdk_node_shutdown(&ref->opaque);
      if (shutdown_result.inner != NULL) {
        rln_free_string(shutdown_result.inner);
      }
      // Retain native state if shutdown failed; live tasks can still own it.
      if (shutdown_result.result != Ok) return;
      ref->shutdown_attempted = true;
    }
    free_sdk_node(ref->opaque);
    ref->opaque.ptr = NULL;
    ref->freed = true;
  }
}

static void sdk_node_teardown(void *data) {
  SdkNodeRef *ref = (SdkNodeRef *)data;
  ref->teardown_registered = false;
  shutdown_and_free_sdk_node(ref);
}

static void sdk_node_destructor(js_env_t *env, void *data, void *hint) {
  SdkNodeRef *ref = (SdkNodeRef *)data;
  unregister_handle(&ref->handle);
  if (ref->teardown_registered) {
    js_remove_teardown_callback(env, sdk_node_teardown, ref);
    ref->teardown_registered = false;
  }
  shutdown_and_free_sdk_node(ref);
  free(ref);
}

static js_value_t *wrap_sdk_node(js_env_t *env, struct COpaqueStruct opaque) {
  SdkNodeRef *ref = (SdkNodeRef *)malloc(sizeof(SdkNodeRef));
  if (ref == NULL) {
    free_sdk_node(opaque);
    js_throw_error(env, "ERR_RLN_ALLOCATION", "Unable to allocate node handle");
    return NULL;
  }
  ref->opaque = opaque;
  ref->freed = false;
  ref->shutdown_attempted = false;
  ref->teardown_registered = false;

  int err = js_add_teardown_callback(env, sdk_node_teardown, ref);
  if (err != 0) {
    shutdown_and_free_sdk_node(ref);
    free(ref);
    js_throw_error(env, NULL, "Unable to register rgb-lightning-node teardown");
    return NULL;
  }
  ref->teardown_registered = true;

  js_value_t *external;
  err = js_create_external(env, ref, sdk_node_destructor, NULL, &external);
  if (err != 0) {
    js_remove_teardown_callback(env, sdk_node_teardown, ref);
    ref->teardown_registered = false;
    shutdown_and_free_sdk_node(ref);
    free(ref);
    js_throw_error(env, NULL, "Unable to create rgb-lightning-node handle");
    return NULL;
  }
  register_handle(&ref->handle, env, HandleKind::Node);
  return external;
}

static const struct COpaqueStruct *require_sdk_node(js_env_t *env,
                                                    js_value_t *val) {
  void *data = NULL;
  if (!read_external(env, val, &data) || !owns_handle(env, data, HandleKind::Node)) {
    js_throw_error(env, "ERR_RLN_NODE_CLOSED",
                   "RGB Lightning node handle is unavailable");
    return NULL;
  }
  SdkNodeRef *ref = (SdkNodeRef *)data;
  if (ref->freed || ref->shutdown_attempted || ref->opaque.ptr == NULL) {
    js_throw_error(env, "ERR_RLN_NODE_CLOSED",
                   "RGB Lightning node is already closed");
    return NULL;
  }
  return &ref->opaque;
}

static SdkNodeRef *unwrap_sdk_node_ref(js_env_t *env, js_value_t *val) {
  void *data = NULL;
  if (!read_external(env, val, &data) || !owns_handle(env, data, HandleKind::Node)) return NULL;
  return (SdkNodeRef *)data;
}

static js_value_t *handle_result_node(js_env_t *env, struct CResult res) {
  if (res.result == Ok) {
    return wrap_sdk_node(env, res.inner);
  } else {
    const char *msg = res.inner.ptr ? (const char *)res.inner.ptr
                                    : "Unknown rgb-lightning-node error";
    js_throw_error(env, NULL, msg);
    if (res.inner.ptr) rln_free_string((char *)res.inner.ptr);
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
  HandleEntry handle;
  struct COpaqueStruct opaque;
  bool freed;
};

static void signer_destructor(js_env_t *env, void *data, void *hint) {
  SignerRef *ref = (SignerRef *)data;
  unregister_handle(&ref->handle);
  if (!ref->freed) {
    free_native_external_signer(ref->opaque);
    ref->freed = true;
  }
  free(ref);
}

static js_value_t *wrap_signer(js_env_t *env, struct COpaqueStruct opaque) {
  SignerRef *ref = (SignerRef *)malloc(sizeof(SignerRef));
  if (ref == NULL) {
    free_native_external_signer(opaque);
    js_throw_error(env, "ERR_RLN_ALLOCATION", "Unable to allocate signer handle");
    return NULL;
  }
  ref->opaque = opaque;
  ref->freed = false;

  js_value_t *external;
  if (js_create_external(env, ref, signer_destructor, NULL, &external) != 0) {
    free_native_external_signer(opaque);
    free(ref);
    js_throw_error(env, "ERR_RLN_ALLOCATION", "Unable to create signer handle");
    return NULL;
  }
  register_handle(&ref->handle, env, HandleKind::Signer);
  return external;
}

static const struct COpaqueStruct *require_signer(js_env_t *env,
                                                  js_value_t *val) {
  void *data = NULL;
  if (!read_external(env, val, &data) || !owns_handle(env, data, HandleKind::Signer)) {
    js_throw_error(env, "ERR_RLN_SIGNER_CLOSED",
                   "RGB Lightning signer handle is unavailable");
    return NULL;
  }
  SignerRef *ref = (SignerRef *)data;
  if (ref->freed || ref->opaque.ptr == NULL) {
    js_throw_error(env, "ERR_RLN_SIGNER_CLOSED",
                   "RGB Lightning signer is already closed");
    return NULL;
  }
  return &ref->opaque;
}

static SignerRef *unwrap_signer_ref(js_env_t *env, js_value_t *val) {
  void *data = NULL;
  if (!read_external(env, val, &data) || !owns_handle(env, data, HandleKind::Signer)) return NULL;
  return (SignerRef *)data;
}

static js_value_t *handle_result_signer(js_env_t *env, struct CResult res) {
  if (res.result == Ok) {
    return wrap_signer(env, res.inner);
  } else {
    const char *msg = res.inner.ptr ? (const char *)res.inner.ptr
                                    : "Unknown rgb-lightning-node error";
    js_throw_error(env, NULL, msg);
    if (res.inner.ptr) rln_free_string((char *)res.inner.ptr);
    js_value_t *undef;
    js_get_undefined(env, &undef);
    return undef;
  }
}

static int get_args(js_env_t *env, js_callback_info_t *info,
                    js_value_t **args, size_t expected) {
  size_t argc = expected;
  for (size_t i = 0; i < expected; i++) js_get_undefined(env, &args[i]);
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
    const struct COpaqueStruct *node = require_sdk_node(env, args[0]);     \
    if (node == NULL) return make_undefined(env);                          \
    return handle_result_string(env, RLN_FN(node));                        \
  }

#define FN_NODE_STR(NAME, RLN_FN)                                          \
  static js_value_t *fn_##NAME(js_env_t *env, js_callback_info_t *info) {  \
    js_value_t *args[2];                                                   \
    get_args(env, info, args, 2);                                          \
    const struct COpaqueStruct *node = require_sdk_node(env, args[0]);     \
    if (node == NULL) return make_undefined(env);                          \
    CStringArg s(env, args[1]); \
    if (!s.valid) return make_undefined(env); \
    struct CResultString res = RLN_FN(node, s);                            \
    return handle_result_string(env, res);                                 \
  }

#define FN_NODE_JSON(NAME, RLN_FN) FN_NODE_STR(NAME, RLN_FN)

#define FN_NODE_BOOL(NAME, RLN_FN)                                         \
  static js_value_t *fn_##NAME(js_env_t *env, js_callback_info_t *info) {  \
    js_value_t *args[2];                                                   \
    get_args(env, info, args, 2);                                          \
    const struct COpaqueStruct *node = require_sdk_node(env, args[0]);     \
    if (node == NULL) return make_undefined(env);                          \
    bool b = false; \
    if (!read_bool(env, args[1], &b)) return make_undefined(env);                                      \
    return handle_result_string(env, RLN_FN(node, b));                     \
  }

// ============================================================================
// Module-level (no node)
// ============================================================================

static js_value_t *fn_get_runtime_info(js_env_t *env, js_callback_info_t *info) {
  return handle_result_string(env, rln_binding_build_info());
}

static js_value_t *fn_uniffi_healthcheck(js_env_t *env, js_callback_info_t *info) {
  return handle_result_string(env, rln_uniffi_healthcheck());
}

static js_value_t *fn_uniffi_is_initialized(js_env_t *env, js_callback_info_t *info) {
  return handle_result_string(env, rln_uniffi_is_initialized());
}

static js_value_t *fn_sdk_initialize(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  CStringArg request_json(env, args[0]);
  if (!request_json.valid) return make_undefined(env);
  struct CResultString res = rln_sdk_initialize(request_json);
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
  CStringArg request_json(env, args[0]);
  if (!request_json.valid) return make_undefined(env);
  struct CResult res = rln_sdk_node_new(request_json);
  return handle_result_node(env, res);
}

static js_value_t *fn_sdk_node_init(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  CStringArg password(env, args[1]);
  if (!password.valid) return make_undefined(env);
  CStringArg mnemonic(env, args[2], true);
  if (!mnemonic.valid) return make_undefined(env);
  struct CResultString res = rln_sdk_node_init(node, password, mnemonic);
  return handle_result_string(env, res);
}

FN_NODE_JSON(sdk_node_unlock, rln_sdk_node_unlock)
static js_value_t *fn_sdk_node_shutdown(js_env_t *env,
                                        js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  SdkNodeRef *ref = unwrap_sdk_node_ref(env, args[0]);
  if (ref == NULL || ref->freed || ref->opaque.ptr == NULL) {
    js_throw_error(env, "ERR_RLN_NODE_CLOSED",
                   "RGB Lightning node is already closed");
    return make_undefined(env);
  }
  if (ref->shutdown_attempted) return make_undefined(env);

  struct CResultString result = rln_sdk_node_shutdown(&ref->opaque);
  if (result.result == Ok) ref->shutdown_attempted = true;
  return handle_result_string(env, result);
}
FN_NODE_JSON(sdk_node_vss_clear_fence, rln_sdk_node_vss_clear_fence)
FN_NODE(sdk_node_vss_backup, rln_sdk_node_vss_backup)

FN_NODE_STR(sdk_node_apay_new, rln_sdk_node_apay_new)

static js_value_t *fn_sdk_node_apay_new_with_address(
    js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[4];
  get_args(env, info, args, 4);
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  CStringArg host_node_id(env, args[1]);
  if (!host_node_id.valid) return make_undefined(env);
  CStringArg username(env, args[2]);
  if (!username.valid) return make_undefined(env);
  CStringArg domain(env, args[3]);
  if (!domain.valid) return make_undefined(env);
  struct CResultString res = rln_sdk_node_apay_new_with_address(
      node, host_node_id, username, domain);
  return handle_result_string(env, res);
}

static js_value_t *fn_sdk_node_destroy(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  SdkNodeRef *ref = unwrap_sdk_node_ref(env, args[0]);
  if (ref == NULL) {
    js_throw_error(env, "ERR_RLN_NODE_CLOSED",
                   "RGB Lightning node handle is unavailable");
    return make_undefined(env);
  }
  if (!ref->freed) {
    shutdown_and_free_sdk_node(ref);
    if (!ref->freed) {
      js_throw_error(env, "ERR_RLN_SHUTDOWN",
                     "Node shutdown failed; handle retained for retry");
      return make_undefined(env);
    }
  }
  if (ref->teardown_registered) {
    js_remove_teardown_callback(env, sdk_node_teardown, ref);
    ref->teardown_registered = false;
  }
  js_value_t *undefined;
  js_get_undefined(env, &undefined);
  return undefined;
}

// ============================================================================
// External-signer surface
// ============================================================================

static js_value_t *fn_native_external_signer_new(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  CStringArg seed_hex(env, args[0]);
  if (!seed_hex.valid) return make_undefined(env);
  CStringArg network(env, args[1]);
  if (!network.valid) return make_undefined(env);
  bool permissive_policy = false;
  if (!read_bool(env, args[2], &permissive_policy)) return make_undefined(env);
  struct CResult res = rln_native_external_signer_new(seed_hex, network, permissive_policy);
  return handle_result_signer(env, res);
}

static js_value_t *fn_native_external_signer_new_with_storage(js_env_t *env,
                                                              js_callback_info_t *info) {
  js_value_t *args[4];
  get_args(env, info, args, 4);
  CStringArg seed_hex(env, args[0]);
  if (!seed_hex.valid) return make_undefined(env);
  CStringArg network(env, args[1]);
  if (!network.valid) return make_undefined(env);
  bool permissive_policy = false;
  if (!read_bool(env, args[2], &permissive_policy)) return make_undefined(env);
  CStringArg storage_dir_path(env, args[3]);
  if (!storage_dir_path.valid) return make_undefined(env);
  struct CResult res = rln_native_external_signer_new_with_storage(
    seed_hex,
    network,
    permissive_policy,
    storage_dir_path
  );
  return handle_result_signer(env, res);
}

static js_value_t *fn_native_external_signer_bootstrap(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  const struct COpaqueStruct *signer = require_signer(env, args[0]);
  if (signer == NULL) return make_undefined(env);
  return handle_result_string(env, rln_native_external_signer_bootstrap(signer));
}

static js_value_t *fn_native_external_signer_destroy(js_env_t *env,
                                                      js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  SignerRef *ref = unwrap_signer_ref(env, args[0]);
  if (ref == NULL) {
    js_throw_error(env, "ERR_RLN_SIGNER_CLOSED", "Native signer handle is unavailable");
    return make_undefined(env);
  }
  if (!ref->freed) {
    free_native_external_signer(ref->opaque);
    ref->opaque.ptr = NULL;
    ref->freed = true;
  }
  js_value_t *undefined;
  js_get_undefined(env, &undefined);
  return undefined;
}

// `node` + `signer` form (3 of these): init / attach / unlock-with-native
// share the same shape — wrap them through a single helper macro.

#define FN_NODE_SIGNER(NAME, RLN_FN)                                          \
  static js_value_t *fn_##NAME(js_env_t *env, js_callback_info_t *info) {     \
    js_value_t *args[2];                                                      \
    get_args(env, info, args, 2);                                             \
    const struct COpaqueStruct *node = require_sdk_node(env, args[0]);        \
    if (node == NULL) return make_undefined(env);                             \
    const struct COpaqueStruct *signer = require_signer(env, args[1]);        \
    if (signer == NULL) return make_undefined(env);                           \
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
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  const struct COpaqueStruct *signer = require_signer(env, args[1]);
  if (signer == NULL) return make_undefined(env);
  CStringArg request_json(env, args[2]);
  if (!request_json.valid) return make_undefined(env);
  struct CResultString res =
    rln_sdk_node_unlock_with_native_external_signer(node, signer, request_json);
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
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  CStringArg hash(env, args[1]);
  if (!hash.valid) return make_undefined(env);
  CStringArg type(env, args[2]);
  if (!type.valid) return make_undefined(env);
  struct CResultString res = rln_get_payment(node, hash, type);
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
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  CStringArg hash(env, args[1]);
  if (!hash.valid) return make_undefined(env);
  bool taker_flag = false;
  if (!read_bool(env, args[2], &taker_flag)) return make_undefined(env);
  struct CResultString res = rln_get_swap(node, hash, taker_flag);
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
FN_NODE_JSON(asset_link_create, rln_asset_link_create)
FN_NODE_STR(asset_metadata, rln_asset_metadata)

static js_value_t *fn_list_transfers(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  CStringArg asset_id(env, args[1], true);
  if (!asset_id.valid) return make_undefined(env);
  CStringArg txid(env, args[2], true);
  if (!txid.valid) return make_undefined(env);
  struct CResultString res = rln_list_transfers(node, asset_id, txid);
  return handle_result_string(env, res);
}

static js_value_t *fn_list_transfers_by_txid(js_env_t *env,
                                              js_callback_info_t *info) {
  js_value_t *args[2];
  get_args(env, info, args, 2);
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  CStringArg txid(env, args[1]);
  if (!txid.valid) return make_undefined(env);
  struct CResultString res = rln_list_transfers(node, NULL, txid);
  return handle_result_string(env, res);
}
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

static js_value_t *fn_list_transactions(js_env_t *env,
                                         js_callback_info_t *info) {
  js_value_t *args[2];
  get_args(env, info, args, 2);
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  bool skip_sync = false;
  if (!read_bool(env, args[1], &skip_sync)) return make_undefined(env);
  return handle_result_string(env,
                              rln_list_transactions(node, skip_sync, NULL));
}

static js_value_t *fn_list_transactions_by_txid(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[3];
  get_args(env, info, args, 3);
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  CStringArg txid(env, args[1]);
  if (!txid.valid) return make_undefined(env);
  bool skip_sync = false;
  if (!read_bool(env, args[2], &skip_sync)) return make_undefined(env);
  struct CResultString res = rln_list_transactions(node, skip_sync, txid);
  return handle_result_string(env, res);
}

FN_NODE_BOOL(list_unspents, rln_list_unspents)
FN_NODE_JSON(create_utxos, rln_create_utxos)

static js_value_t *fn_estimate_fee(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[2];
  get_args(env, info, args, 2);
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  double value = 0;
  js_value_type_t type;
  if (js_typeof(env, args[1], &type) != 0 || type != js_number ||
      js_get_value_double(env, args[1], &value) != 0 || !isfinite(value) ||
      value < 1 || value > UINT16_MAX || floor(value) != value) {
    js_throw_type_error(env, "ERR_RLN_ARGUMENT", "Fee target must be a positive u16 integer");
    return make_undefined(env);
  }
  uint16_t blocks = (uint16_t)value;
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
  const struct COpaqueStruct *node = require_sdk_node(env, args[0]);
  if (node == NULL) return make_undefined(env);
  CStringArg message(env, args[1]);
  if (!message.valid) return make_undefined(env);
  CStringArg signature(env, args[2]);
  if (!signature.valid) return make_undefined(env);
  struct CResultString res = rln_verify_message(node, message, signature);
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
  EXPORT("getRuntimeInfo", get_runtime_info);
  EXPORT("uniffiHealthcheck", uniffi_healthcheck);
  EXPORT("uniffiIsInitialized", uniffi_is_initialized);
  EXPORT("sdkInitialize", sdk_initialize);
  EXPORT("sdkShutdown", sdk_shutdown);

  // Lifecycle
  EXPORT("sdkNodeNew", sdk_node_new);
  EXPORT("sdkNodeInit", sdk_node_init);
  EXPORT("sdkNodeUnlock", sdk_node_unlock);
  EXPORT("sdkNodeShutdown", sdk_node_shutdown);
  EXPORT("sdkNodeDestroy", sdk_node_destroy);
  EXPORT("sdkNodeVssClearFence", sdk_node_vss_clear_fence);
  EXPORT("sdkNodeVssBackup", sdk_node_vss_backup);
  EXPORT("sdkNodeApayNew", sdk_node_apay_new);
  EXPORT("sdkNodeApayNewWithAddress", sdk_node_apay_new_with_address);

  // External signer (native — recommended)
  EXPORT("nativeExternalSignerNew", native_external_signer_new);
  EXPORT("nativeExternalSignerNewWithStorage", native_external_signer_new_with_storage);
  EXPORT("nativeExternalSignerBootstrap", native_external_signer_bootstrap);
  EXPORT("nativeExternalSignerDestroy", native_external_signer_destroy);
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
  EXPORT("assetLinkCreate", asset_link_create);
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
