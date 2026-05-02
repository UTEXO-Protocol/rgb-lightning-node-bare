/**
 * @utexo/rgb-lightning-node-bare — Bare native addon wrapping the
 * rgb-lightning-node C-FFI.
 *
 * Canary build: only the lifecycle + smoke-test surface is wired up
 * (healthcheck, is_initialized, sdk_node_new/init/unlock/shutdown,
 * node_info). Mirrors the rgb-lib-bare pattern (sodium-native style:
 * <bare.h> + <js.h>).
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
    // Best-effort: shut the node down before freeing the box. shutdown()
    // is idempotent and safe to call when init/unlock haven't run.
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

static int get_args(js_env_t *env, js_callback_info_t *info,
                    js_value_t **args, size_t expected) {
  size_t argc = expected;
  js_get_callback_info(env, info, &argc, args, NULL, NULL);
  return (int)argc;
}

// ============================================================================
// Module-level helpers (no handle)
// ============================================================================

static js_value_t *fn_uniffi_healthcheck(js_env_t *env, js_callback_info_t *info) {
  return handle_result_string(env, rln_uniffi_healthcheck());
}

static js_value_t *fn_uniffi_is_initialized(js_env_t *env, js_callback_info_t *info) {
  return handle_result_string(env, rln_uniffi_is_initialized());
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

static js_value_t *fn_sdk_node_unlock(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[2];
  get_args(env, info, args, 2);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  char *request_json = js_to_cstring(env, args[1]);
  struct CResultString res = rln_sdk_node_unlock(node, request_json);
  free(request_json);
  return handle_result_string(env, res);
}

static js_value_t *fn_sdk_node_shutdown(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  return handle_result_string(env, rln_sdk_node_shutdown(node));
}

// ============================================================================
// Node info (the one read-only call we wire up for the canary)
// ============================================================================

static js_value_t *fn_node_info(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[1];
  get_args(env, info, args, 1);
  const struct COpaqueStruct *node = unwrap_sdk_node(env, args[0]);
  return handle_result_string(env, rln_node_info(node));
}

// ============================================================================
// Module exports
// ============================================================================

static void set_fn(js_env_t *env, js_value_t *exports, const char *name,
                   js_value_t *(*fn)(js_env_t *, js_callback_info_t *)) {
  js_value_t *js_fn;
  js_create_function(env, name, strlen(name), fn, NULL, &js_fn);
  js_set_named_property(env, exports, name, js_fn);
}

static js_value_t *
rgb_lightning_node_bare_exports(js_env_t *env, js_value_t *exports) {
  // Module-level
  set_fn(env, exports, "uniffiHealthcheck", fn_uniffi_healthcheck);
  set_fn(env, exports, "uniffiIsInitialized", fn_uniffi_is_initialized);

  // Lifecycle
  set_fn(env, exports, "sdkNodeNew", fn_sdk_node_new);
  set_fn(env, exports, "sdkNodeInit", fn_sdk_node_init);
  set_fn(env, exports, "sdkNodeUnlock", fn_sdk_node_unlock);
  set_fn(env, exports, "sdkNodeShutdown", fn_sdk_node_shutdown);

  // Read-only canary
  set_fn(env, exports, "nodeInfo", fn_node_info);

  return exports;
}

BARE_MODULE(rgb_lightning_node_bare, rgb_lightning_node_bare_exports)
