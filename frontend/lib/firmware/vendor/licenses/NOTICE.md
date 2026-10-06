# Browser firmware compiler notices

Worker code adapted from [Sekiz](https://github.com/senolgulgonul/sekiz/tree/d7bd0d4e1cf0ab3f237c1c0c475b50264922d3fe), copyright Senol Gulgonul (2026), MIT. Compiler binaries and AVR sysroot are pinned to that commit and checked by SHA-256 before deployment. The manifest is distributed at `/vendor/avr/manifest.json`.

Clang/LLD use the LLVM Apache 2.0 license with LLVM exception, included in LLVM-LICENSE.txt. The corresponding toolchain build sources and instructions are at https://github.com/senolgulgonul/sekiz-toolchain . Its sysroot contains AVR libc, compiler runtime and the Arduino AVR core; preserve upstream copyright notices when rebuilding. Source references: https://github.com/avrdudes/avr-libc and https://github.com/arduino/ArduinoCore-avr . The original sysroot archive is available at `/vendor/avr/sysroot.tar.gz`.

Bundled Arduino Wire/SPI source is from ArduinoCore-avr commit `42fa4a1ea1b1b11d1cc0a60298e529d37f9d14bd` (tag 1.8.6), LGPL 2.1 or later. Complete bundled source, original copyright headers and hashes are distributed at `/vendor/avr/libraries.json`. Full upstream core sources: https://github.com/arduino/ArduinoCore-avr/tree/42fa4a1ea1b1b11d1cc0a60298e529d37f9d14bd . Compiled projects use the Arduino library runtime; users can rebuild or replace the toolchain/sysroot using the linked source and build instructions.

DunkAI modifications: fixed-origin asset loading, limits/timeouts, multiple project files, cancellation, and bundled Wire/SPI compilation. No generated firmware is executed by the website.
