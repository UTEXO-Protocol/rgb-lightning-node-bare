cmake_minimum_required(VERSION 3.25)

project(rgb_lightning_node_bare CXX C)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

set(CMAKE_POSITION_INDEPENDENT_CODE ON)

bare_target(target)

add_bare_module(rgb_lightning_node_bare)

# Android NDK sets -Wl,--no-undefined globally, which prevents js_* symbols
# from being left unresolved. These symbols are provided by bare-kit at runtime.
if(target MATCHES "android")
  target_link_options(
    ${rgb_lightning_node_bare}_module
    PRIVATE
      "-Wl,--unresolved-symbols=ignore-all"
  )
endif()

target_sources(
  ${rgb_lightning_node_bare}
  PRIVATE
    binding.cc
)

target_include_directories(
  ${rgb_lightning_node_bare}
  PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
)

# Link precompiled Rust static library for current target
add_library(rlncffi STATIC IMPORTED)
set_target_properties(rlncffi PROPERTIES
  IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/lib/${target}/librlncffi.a"
)

target_link_libraries(
  ${rgb_lightning_node_bare}
  PRIVATE
    rlncffi
)

# Platform-specific system library linkage. RLN pulls in LDK (rust-lightning),
# which needs the same TLS / system framework set as rgb-lib's electrum path,
# plus a few extras (libresolv for DNS, libsqlite3 for the LDK persister).
if(target MATCHES "ios")
  target_link_libraries(
    ${rgb_lightning_node_bare}
    PRIVATE
      "-framework Security"
      "-framework SystemConfiguration"
      "-framework CoreFoundation"
      "-lc++"
      "-lz"
      "-lsqlite3"
      "-lresolv"
  )
elseif(target MATCHES "darwin")
  target_link_libraries(
    ${rgb_lightning_node_bare}
    PRIVATE
      "-framework Security"
      "-framework SystemConfiguration"
      "-framework CoreFoundation"
      "-lc++"
      "-lz"
      "-lsqlite3"
      "-lresolv"
  )
elseif(target MATCHES "android")
  target_link_libraries(
    ${rgb_lightning_node_bare}
    PRIVATE
      "-llog"
      "-lz"
      "-ldl"
      "-lm"
      "-latomic"
  )
elseif(target MATCHES "linux")
  target_link_libraries(
    ${rgb_lightning_node_bare}
    PRIVATE
      "-lpthread"
      "-ldl"
      "-lm"
      "-lz"
      "-lsqlite3"
  )
endif()
