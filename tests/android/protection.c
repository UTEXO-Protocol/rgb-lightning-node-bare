#define _GNU_SOURCE
#include <jni.h>
#include <link.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

struct ranges {
  uintptr_t relro_start, relro_end, dynamic_start, dynamic_end;
  int found;
};

static int find_module(struct dl_phdr_info *info, size_t size, void *data) {
  (void) size;
  if (!strstr(info->dlpi_name, "libutexo__rgb-lightning-node-bare.0.2.0-beta.3.so")) return 0;
  struct ranges *r = data;
  r->found++;
  for (int i = 0; i < info->dlpi_phnum; i++) {
    const ElfW(Phdr) *p = &info->dlpi_phdr[i];
    if (p->p_type == PT_GNU_RELRO) {
      r->relro_start = info->dlpi_addr + p->p_vaddr;
      r->relro_end = r->relro_start + p->p_memsz;
    } else if (p->p_type == PT_DYNAMIC) {
      r->dynamic_start = info->dlpi_addr + p->p_vaddr;
      r->dynamic_end = r->dynamic_start + p->p_memsz;
    }
  }
  return 0;
}

static int read_only(uintptr_t from, uintptr_t to) {
  FILE *maps = fopen("/proc/self/maps", "r");
  if (!maps) return 0;
  char line[4096], perms[5];
  uintptr_t covered = from;
  while (fgets(line, sizeof(line), maps)) {
    unsigned long start, end;
    if (sscanf(line, "%lx-%lx %4s", &start, &end, perms) != 3) continue;
    if (end <= covered || start >= to) continue;
    if (start > covered || perms[0] != 'r' || perms[1] == 'w' || perms[2] == 'x') break;
    covered = end;
    if (covered >= to) break;
  }
  fclose(maps);
  return from < to && covered >= to;
}

JNIEXPORT jstring JNICALL Java_com_utexo_linkqualification_Runner_protection(JNIEnv *env, jclass clazz) {
  (void) clazz;
  struct ranges r = {0};
  dl_iterate_phdr(find_module, &r);
  if (r.found != 1 || !r.relro_start || !r.dynamic_start ||
      r.dynamic_start < r.relro_start || r.dynamic_end > r.relro_end ||
      !read_only(r.relro_start, r.relro_end) || !read_only(r.dynamic_start, r.dynamic_end)) {
    (*env)->ThrowNew(env, (*env)->FindClass(env, "java/lang/AssertionError"), "RLN RELRO/DYNAMIC is not mapped read-only");
    return NULL;
  }
  char json[192];
  snprintf(json, sizeof(json), "{\"pageSize\":%ld,\"relroReadOnly\":true,\"dynamicReadOnly\":true,\"singleModule\":true}", sysconf(_SC_PAGESIZE));
  return (*env)->NewStringUTF(env, json);
}
