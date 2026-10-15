// Exercise the real wrapper lifecycle helpers with controlled FFI/JS failures.
#include <vector>
#include <bare.h>
#undef BARE_MODULE
#define BARE_MODULE(name, init)
#include "../../binding.cc"
#include <assert.h>
#include <algorithm>
#include <string>

struct Callback { js_env_t *env; js_teardown_cb fn; void *data; };
static std::vector<Callback> callbacks;
static std::vector<std::string> events;
static bool fail_add = false, fail_external = false, fail_node = false, fail_signer = false;
static int errors = 0;

extern "C" int js_add_teardown_callback(js_env_t *env, js_teardown_cb fn, void *data) {
  if (fail_add) return -1;
  callbacks.push_back({env, fn, data}); return 0;
}
extern "C" int js_remove_teardown_callback(js_env_t *env, js_teardown_cb fn, void *data) {
  auto i = std::find_if(callbacks.begin(), callbacks.end(), [=](const Callback &c) {
    return c.env == env && c.fn == fn && c.data == data;
  });
  assert(i != callbacks.end()); callbacks.erase(i); return 0;
}
extern "C" int js_create_external(js_env_t *, void *data, js_finalize_cb, void *, js_value_t **out) {
  if (fail_external) return -1;
  *out = (js_value_t *)data; return 0;
}
extern "C" int js_throw_error(js_env_t *, const char *, const char *) { ++errors; return 0; }
extern "C" void rln_free_string(char *p) { free(p); }
extern "C" CResultString rln_sdk_node_shutdown(const COpaqueStruct *) {
  events.push_back("node-stop"); return {fail_node ? Err : Ok, nullptr};
}
extern "C" void free_sdk_node(COpaqueStruct) { events.push_back("node-free"); }
extern "C" CResultString rln_native_external_signer_shutdown(const COpaqueStruct *) {
  events.push_back("signer-stop"); return {fail_signer ? Err : Ok, nullptr};
}
extern "C" void free_native_external_signer(COpaqueStruct) { events.push_back("signer-free"); }

static js_env_t *env(unsigned id) { return (js_env_t *)(uintptr_t)id; }
static COpaqueStruct opaque(unsigned id) { return {(void *)(uintptr_t)id, 0}; }
static SignerRef *signer(js_env_t *e) { return (SignerRef *)wrap_signer(e, opaque(1)); }
static SdkNodeRef *node(js_env_t *e) { return (SdkNodeRef *)wrap_sdk_node(e, opaque(2)); }
static size_t count(const char *event) { return std::count(events.begin(), events.end(), event); }
static void teardown(js_env_t *e) {
  // Exercise the unsafe registration-order case explicitly: signers first.
  for (auto fn : {signer_teardown, sdk_node_teardown}) {
    for (;;) {
      auto i = std::find_if(callbacks.begin(), callbacks.end(), [=](const Callback &c) { return c.env == e && c.fn == fn; });
      if (i == callbacks.end()) break;
      auto c = *i; callbacks.erase(i); c.fn(c.data);
    }
  }
}
static void clear() {
  assert(callbacks.empty()); assert(handles == nullptr);
  events.clear(); fail_add = fail_external = fail_node = fail_signer = false; errors = 0;
}
struct Finalizer { js_env_t *env; void *data; void *hint; HandleKind kind; };
static Finalizer finalizer(HandleEntry *h) { return {h->env, h, (void *)h->id, h->kind}; }
static void finalize(Finalizer f) {
  if (f.kind == HandleKind::Node) sdk_node_destructor(f.env, f.data, f.hint);
  else signer_destructor(f.env, f.data, f.hint);
}
int main() {
  // Terminal loss owns wrapper memory; a late or duplicate GC is a lookup miss.
  { auto s = signer(env(1)); auto f = finalizer(&s->handle); teardown(env(1));
    assert(handles == nullptr && count("signer-stop") == 1 && count("signer-free") == 1);
    finalize(f); finalize(f); assert(count("signer-free") == 1); }
  clear();
  // Normal GC remains ownership-only and removes its terminal callback.
  { auto n = node(env(1)); auto nf = finalizer(&n->handle); auto s = signer(env(1));
    finalize(finalizer(&s->handle));
    assert(count("signer-stop") == 0 && count("signer-free") == 1 && !n->freed);
    teardown(env(1)); finalize(nf); }
  clear();
  // Both construction orders: drain ALL same-env nodes before any revocation,
  // do not touch a different environment, do not remove callbacks mid-teardown.
  for (bool node_first : {false, true}) {
    auto n = node_first ? node(env(1)) : nullptr; auto s = signer(env(1));
    if (!n) n = node(env(1));
    auto n2 = node(env(1)); auto other = node(env(2));
    auto nf = finalizer(&n->handle), sf = finalizer(&s->handle);
    auto n2f = finalizer(&n2->handle), of = finalizer(&other->handle);
    teardown(env(1)); assert(!other->freed);
    assert(events.size() == 6 && events[0] == "node-stop" && events[1] == "node-free" &&
      events[2] == "node-stop" && events[3] == "node-free" && events[4] == "signer-stop" && events[5] == "signer-free");
    finalize(nf); finalize(sf); finalize(n2f); teardown(env(2)); finalize(of); clear();
  }
  // Multiple signer stores in one environment all close, while a failed node
  // in a different environment cannot block this environment's cleanup.
  { auto n = node(env(1)); auto s = signer(env(1)); auto s2 = signer(env(1));
    auto other = node(env(2));
    auto nf = finalizer(&n->handle), sf = finalizer(&s->handle);
    auto s2f = finalizer(&s2->handle), of = finalizer(&other->handle);
    fail_node = true; sdk_node_teardown(of.hint); assert(!other->freed);
    fail_node = false; events.clear(); teardown(env(1));
    assert(count("node-stop") == 1 && count("signer-stop") == 2 && count("signer-free") == 2);
    assert(!other->freed); finalize(nf); finalize(sf); finalize(s2f);
    // Its callback was invoked directly above rather than by our dispatcher.
    callbacks.erase(std::remove_if(callbacks.begin(), callbacks.end(), [](const Callback &c) { return c.env == env(2); }), callbacks.end());
    finalize(of); clear();
  }
  // A failed stop never revokes the signer; a later finalizer can retry safely.
  { auto n = node(env(1)); auto s = signer(env(1));
    auto nf = finalizer(&n->handle), sf = finalizer(&s->handle);
    fail_node = true; teardown(env(1));
    assert(!n->freed && !s->freed && count("signer-stop") == 0 && count("signer-free") == 0);
    fail_node = false; finalize(nf); finalize(sf); assert(count("signer-stop") == 0); }
  clear();
  // A failed GC node shutdown retains the terminal callback for a later retry.
  { auto n = node(env(1)); auto nf = finalizer(&n->handle); fail_node = true;
    finalize(nf); assert(n->teardown_registered && handles != nullptr);
    fail_node = false; teardown(env(1)); finalize(nf); }
  clear();
  { auto s = signer(env(1)); auto sf = finalizer(&s->handle); fail_signer = true;
    teardown(env(1)); assert(!s->freed && count("signer-stop") == 1 && count("signer-free") == 0);
    finalize(sf); assert(count("signer-free") == 1); }
  clear();
  // Explicit host release leaves only terminal wrapper cleanup, no revocation.
  { auto s = signer(env(1)); auto sf = finalizer(&s->handle);
    free_native_external_signer(s->opaque); s->opaque.ptr = nullptr; s->freed = true;
    teardown(env(1)); finalize(sf); assert(count("signer-stop") == 0 && count("signer-free") == 1); }
  clear();
  // No per-environment wrapper/registry retention when libjs skips finalizers.
  for (unsigned i = 0; i < 1000; ++i) {
    auto n = node(env(1)); auto s = signer(env(1));
    auto nf = finalizer(&n->handle), sf = finalizer(&s->handle);
    teardown(env(1)); assert(handles == nullptr && callbacks.empty());
    auto next = signer(env(1));
    // Even identical address/env reuse cannot let an old generation finalize it.
    signer_destructor(env(1), next, sf.hint); assert(!next->freed);
    finalize(nf); finalize(sf); finalize(finalizer(&next->handle)); clear();
  }
  for (bool external_failure : {false, true}) {
    fail_add = !external_failure; fail_external = external_failure;
    assert(wrap_signer(env(1), opaque(1)) == nullptr);
    assert(errors == 1 && count("signer-free") == 1); clear();
    fail_add = !external_failure; fail_external = external_failure;
    assert(wrap_sdk_node(env(1), opaque(2)) == nullptr);
    assert(errors == 1 && count("node-stop") == 1 && count("node-free") == 1); clear();
  }
  // Portable uintptr_t IDs never wrap/reuse, including the Android arm32 case.
  const uintptr_t saved = next_handle_id; next_handle_id = UINTPTR_MAX;
  { auto s = signer(env(1)); auto sf = finalizer(&s->handle); assert(next_handle_id == 0);
    assert(wrap_signer(env(1), opaque(1)) == nullptr);
    assert(wrap_sdk_node(env(1), opaque(2)) == nullptr);
    finalize(sf); assert(handles == nullptr && callbacks.empty()); }
  next_handle_id = saved; clear();
  puts("native lifecycle fault/order controls passed");
}
