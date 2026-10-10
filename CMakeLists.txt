cmake_minimum_required(VERSION 3.25)

project(rgb_lightning_node_bare CXX C)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

# cmake-bare defaults to downloading latest headers. Use the locked npm dependency.
function(download_bare_headers result)
  execute_process(
    COMMAND node "${CMAKE_CURRENT_SOURCE_DIR}/scripts/resolve-package-root.js" bare-headers "${CMAKE_CURRENT_SOURCE_DIR}"
    OUTPUT_VARIABLE header_root
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
  )
  file(READ "${header_root}/package.json" header_package)
  string(JSON header_version GET "${header_package}" version)
  if(NOT header_version STREQUAL "1.30.0")
    message(FATAL_ERROR "Expected bare-headers 1.30.0")
  endif()
  set(${result} "${header_root}/include" PARENT_SCOPE)
endfunction()

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
